# Chatterbox TTS Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Gemini Live TTS with a self-hosted ResembleAI Chatterbox Turbo sidecar (Python + FastAPI). Bun spawns the sidecar on boot, the frontend plays WAV files via plain `<audio>` elements, and generated audio is content-hash cached on disk for instant cross-session replay.

**Architecture:** Two-process. Bun owns the game and spawns a Python child for TTS. Bun talks to the sidecar over local HTTP (POST text in, get WAV bytes back). Bun writes each generated WAV to `media/audio/<sha256-of-text-voice>.wav`, then emits a WS message containing the URL. Frontend sets it on an `<audio>` element. This deletes ~300 lines of streaming-PCM machinery from the earlier audio refactor; the simpler protocol doesn't need it.

**Tech Stack:** Bun (existing), TypeScript, React 19, `bun:test`. New: Python 3.11+, FastAPI, Uvicorn, `chatterbox-tts` package (PyPI), PyTorch (transitive).

**Reference spec:** `docs/superpowers/specs/2026-05-13-chatterbox-tts-design.md`

---

## Environment notes for the implementer

- The subagent doing this work probably does NOT have Python, PyTorch, or Chatterbox installed. **Python tests are specified but you are not expected to run them** — write them, lint them mentally, commit them. The user will run them after merge.
- The subagent DOES have Bun. All `bun test` commands should be run and verified.
- The subagent CANNOT verify the real sidecar lifecycle end-to-end. That's the user's manual verification at the end of the plan.
- Voice reference WAVs will be generated manually by the user via `tts_sidecar/generate_voices.py` after the code lands. Until then, the sidecar returns a clear error on `/tts` calls. This is fine for the subagent's work — no real WAVs needed during implementation.

---

## File Structure

**New top-level directory: `tts_sidecar/`**

- `tts_sidecar/server.py` — FastAPI app, model lifecycle, request handlers
- `tts_sidecar/generate_voices.py` — one-shot script to create the bundled reference clips
- `tts_sidecar/requirements.txt` — Python deps
- `tts_sidecar/README.md` — Python setup, model size, GPU notes
- `tts_sidecar/test_server.py` — pytest with TestClient + mocked Chatterbox
- `tts_sidecar/voices/.gitkeep` — placeholder; real WAVs live here after user runs `generate_voices.py`

**New Bun-side files:**

- `src/sidecar.ts` — spawns Python child, polls /health, tracks `narrationReady`
- `src/sidecar.test.ts` — tests with mocked `Bun.spawn`
- `src/tts.ts` — synthesizeToFile (hash-cache + sidecar client), listSidecarVoices
- `src/tts.test.ts` — cache-hit, cache-miss, sidecar-error tests with mocked fetch

**Heavily modified:**

- `src/server.ts` — boot sidecar in main(), emit `audio-ready` WS, drop audio-chunk path, narrationReady in snapshot
- `src/server.test.ts` — assert new WS shape
- `src/config.ts` — add `useNarration`, drop `useGeminiNarration`
- `src/config.test.ts` — update tests
- `src/web/playback-controller.ts` — slim to `<audio>` element coordination
- `src/web/playback-controller.test.ts` — most existing tests deleted, new ones for the simpler controller
- `src/web/app.tsx` — handle `audio-ready`, drop audio-chunk handlers, simpler speaker click
- `.env-sample`, `README.md`, `.gitignore`

**Deleted:**

- `src/gemini-tts.ts` (replaced by `src/tts.ts`)
- `src/web/tts.ts` entirely
- `src/web/tts.test.ts` entirely

---

## Task 1: Python sidecar skeleton with mock generate

**Files:**
- Create: `tts_sidecar/requirements.txt`
- Create: `tts_sidecar/server.py`
- Create: `tts_sidecar/voices/.gitkeep`

Bootstrap the FastAPI app with both endpoints (`/health` and `/tts`) using a mocked generate function. No real Chatterbox model yet — that comes in Task 3. This lets Bun-side tasks proceed against a real (if mock-backed) HTTP API.

- [ ] **Step 1: Create `tts_sidecar/requirements.txt`**

```
fastapi==0.115.5
uvicorn[standard]==0.32.0
pytest==8.3.3
httpx==0.27.2
```

`chatterbox-tts` will be added in Task 3 once we wire the real model — we keep it out of the initial requirements so the placeholder server is lightweight.

- [ ] **Step 2: Create `tts_sidecar/voices/.gitkeep`**

An empty file. Just so the empty `voices/` directory exists in git. Content: empty.

- [ ] **Step 3: Create `tts_sidecar/server.py` with mock generate**

```python
"""Chatterbox TTS sidecar — FastAPI server.

Bun spawns this as a child process. Communication is local HTTP.
The real Chatterbox model is wired in Task 3 of the plan; this skeleton
returns a 1-second silent WAV so the integration can be built and tested
end-to-end before the heavy ML deps are installed.
"""

import io
import os
import struct
import sys
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse

VOICES_DIR = Path(__file__).parent / "voices"
SAMPLE_RATE = 24000

# Module-level state. The real model is loaded into _model in Task 3.
_model = None
_ready = False


def list_voices() -> list[str]:
    """Voice slugs are derived from the WAV files in voices/."""
    if not VOICES_DIR.exists():
        return []
    return sorted(p.stem for p in VOICES_DIR.glob("*.wav"))


def make_silent_wav(seconds: float = 1.0) -> bytes:
    """Mock generate output — a silent 16-bit PCM WAV at SAMPLE_RATE Hz."""
    n_samples = int(seconds * SAMPLE_RATE)
    pcm = b"\x00\x00" * n_samples
    data_size = len(pcm)
    header = b"RIFF" + struct.pack("<I", 36 + data_size) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16)
    header += b"data" + struct.pack("<I", data_size)
    return header + pcm


def generate_audio(text: str, voice: str) -> bytes:
    """Mock implementation. Task 3 replaces this with real Chatterbox.

    Returns raw WAV bytes (full file with RIFF header).
    """
    if _model is None:
        # In the mock skeleton phase, every call returns silent WAV.
        return make_silent_wav(1.0)
    # Real implementation lands in Task 3.
    raise RuntimeError("real generate not yet wired")


app = FastAPI(title="Chatterbox TTS sidecar")


@app.on_event("startup")
async def on_startup() -> None:
    """Mark ready immediately in the skeleton phase.

    Task 3 replaces this with real model load (which takes 5-15s).
    """
    global _ready
    _ready = True
    print(f"[tts-sidecar] ready (mock mode); voices: {list_voices()}", flush=True)


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"ready": _ready, "voices": list_voices()})


@app.post("/tts")
async def tts(request: Request, voice: str = Query(...)) -> Response:
    if voice not in list_voices() and voice != "mock":
        # In mock-only mode we accept "mock" as a passthrough so the
        # sidecar can be exercised before any real voices are generated.
        # After Task 3 + user runs generate_voices.py, real voices show up here.
        if not list_voices():
            raise HTTPException(
                status_code=503,
                detail=(
                    f"no voices configured. Run `python tts_sidecar/generate_voices.py` "
                    f"to populate tts_sidecar/voices/, or pass voice=mock to test the API."
                ),
            )
        raise HTTPException(status_code=404, detail=f"unknown voice: {voice}")

    body = await request.body()
    text = body.decode("utf-8").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text body is required")

    try:
        wav_bytes = generate_audio(text, voice)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"generate failed: {exc}")

    return Response(content=wav_bytes, media_type="audio/wav")


def main() -> None:
    import uvicorn

    host = os.environ.get("TTS_SIDECAR_HOST", "127.0.0.1")
    port = int(os.environ.get("TTS_SIDECAR_PORT", "5005"))
    # log_level=warning keeps the sidecar quiet by default; Bun adds its own
    # [tts-sidecar] prefix to whatever bubbles up.
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Verify the file imports cleanly (syntax check only)**

The subagent cannot run Python. Verify with a textual review:
- `from fastapi import FastAPI, HTTPException, Query, Request, Response` — matches FastAPI 0.115 API
- `@app.on_event("startup")` — FastAPI startup hook (note: deprecated in newer FastAPI in favor of lifespan; for 0.115 it still works)
- `JSONResponse` and `Response` imports — both exist in fastapi.responses

Smell check: does the file structure look reasonable? Are there obvious typos? If yes, commit. If something looks wrong, fix inline.

- [ ] **Step 5: Commit**

```bash
git add tts_sidecar/
git commit -m "feat(tts-sidecar): FastAPI skeleton with mock generate + /health + /tts"
```

---

## Task 2: Python tests for the sidecar (using TestClient + mocks)

**Files:**
- Create: `tts_sidecar/test_server.py`

Specify the test coverage. The subagent writes these tests but cannot run them — the user runs `pytest tts_sidecar/test_server.py` after merge.

- [ ] **Step 1: Create `tts_sidecar/test_server.py`**

```python
"""Tests for the Chatterbox TTS sidecar.

Run with: pytest tts_sidecar/test_server.py

These tests use FastAPI's TestClient and DO NOT load the real Chatterbox
model. Real model behavior is exercised only by manual verification at
the end of the plan.
"""

from pathlib import Path
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    # Point VOICES_DIR at an empty temp dir so each test starts clean.
    from tts_sidecar import server as srv

    voices_dir = tmp_path / "voices"
    voices_dir.mkdir()
    monkeypatch.setattr(srv, "VOICES_DIR", voices_dir)
    monkeypatch.setattr(srv, "_ready", True)

    return TestClient(srv.app)


def test_health_returns_ready_and_voices(client):
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["ready"] is True
    assert body["voices"] == []  # empty voices dir


def test_health_lists_voices_when_files_present(client, monkeypatch, tmp_path):
    from tts_sidecar import server as srv

    # Drop a fake WAV into the patched voices dir.
    (srv.VOICES_DIR / "noir.wav").write_bytes(b"RIFF....")
    (srv.VOICES_DIR / "warm.wav").write_bytes(b"RIFF....")

    res = client.get("/health")
    body = res.json()
    assert sorted(body["voices"]) == ["noir", "warm"]


def test_tts_empty_text_returns_400(client):
    res = client.post("/tts?voice=mock", content=b"")
    assert res.status_code == 400


def test_tts_unknown_voice_with_no_real_voices_returns_503(client):
    # Empty voices dir AND not "mock" → guidance about generate_voices.py
    res = client.post("/tts?voice=noir", content=b"hello")
    assert res.status_code == 503
    assert "generate_voices.py" in res.json()["detail"]


def test_tts_unknown_voice_with_real_voices_returns_404(client):
    from tts_sidecar import server as srv

    (srv.VOICES_DIR / "noir.wav").write_bytes(b"RIFF....")

    res = client.post("/tts?voice=bogus", content=b"hello")
    assert res.status_code == 404


def test_tts_mock_voice_returns_silent_wav(client):
    res = client.post("/tts?voice=mock", content=b"hello world")
    assert res.status_code == 200
    assert res.headers["content-type"] == "audio/wav"
    # Silent 1-second WAV at 24kHz, 16-bit mono: 44-byte header + 48000 bytes PCM.
    assert len(res.content) == 44 + 24000 * 2


def test_tts_real_voice_returns_silent_wav_in_mock_mode(client):
    from tts_sidecar import server as srv

    (srv.VOICES_DIR / "noir.wav").write_bytes(b"RIFF....")

    res = client.post("/tts?voice=noir", content=b"hello world")
    assert res.status_code == 200
    assert res.headers["content-type"] == "audio/wav"
    # Still silent in mock mode, even with real-named voice
    assert len(res.content) == 44 + 24000 * 2


def test_tts_generate_exception_returns_500(client, monkeypatch):
    from tts_sidecar import server as srv

    def boom(text, voice):
        raise RuntimeError("model on fire")

    monkeypatch.setattr(srv, "generate_audio", boom)
    res = client.post("/tts?voice=mock", content=b"hello")
    assert res.status_code == 500
    assert "model on fire" in res.json()["detail"]
```

- [ ] **Step 2: Commit**

```bash
git add tts_sidecar/test_server.py
git commit -m "test(tts-sidecar): pytest cases for /health and /tts using TestClient"
```

---

## Task 3: Wire real ChatterboxTurboTTS

**Files:**
- Modify: `tts_sidecar/requirements.txt`
- Modify: `tts_sidecar/server.py`

Replace the mock `generate_audio` with the real Chatterbox model. Loads on startup (async, marks `_ready=True` only after load completes).

- [ ] **Step 1: Add chatterbox-tts to requirements**

Update `tts_sidecar/requirements.txt` to:

```
fastapi==0.115.5
uvicorn[standard]==0.32.0
pytest==8.3.3
httpx==0.27.2
chatterbox-tts==0.1.7
```

Note: chatterbox-tts pulls in torch 2.6.0, torchaudio 2.6.0, librosa 0.11.0, numpy, s3tokenizer. Heavy install (~5GB). The user will install this once; the subagent doesn't need to.

- [ ] **Step 2: Update `tts_sidecar/server.py` to load and use the real model**

Replace these sections of `tts_sidecar/server.py`:

The `_model` global, the `generate_audio` function, and the `on_startup` handler. New versions:

```python
# Module-level state. The model loads asynchronously on startup.
_model = None
_ready = False
_load_error: Optional[str] = None


def generate_audio(text: str, voice: str) -> bytes:
    """Generate WAV bytes via Chatterbox Turbo using the named voice reference."""
    if _model is None:
        raise RuntimeError(
            f"model not loaded yet "
            f"(load_error={_load_error!r}, ready={_ready})"
        )

    voice_path = VOICES_DIR / f"{voice}.wav"
    if not voice_path.exists():
        raise RuntimeError(f"voice reference file missing: {voice_path}")

    # Chatterbox returns a torch tensor; convert to a WAV byte buffer.
    import torchaudio as ta

    wav_tensor = _model.generate(text, audio_prompt_path=str(voice_path))
    buf = io.BytesIO()
    ta.save(buf, wav_tensor, _model.sr, format="wav")
    return buf.getvalue()


@app.on_event("startup")
async def on_startup() -> None:
    """Load Chatterbox Turbo. Sets _ready=True on success, _load_error on failure.

    Heavy: 5-15s on a consumer GPU. Bun polls /health to know when it's done.
    """
    global _model, _ready, _load_error

    # Import lazily so the rest of the module can be imported without torch.
    try:
        import torch  # noqa: F401  (presence check)
        from chatterbox.tts_turbo import ChatterboxTurboTTS
    except ImportError as exc:
        _load_error = f"missing dependency: {exc}"
        print(f"[tts-sidecar] startup failed: {_load_error}", flush=True)
        return

    device = "cuda" if _cuda_available() else "cpu"
    try:
        print(f"[tts-sidecar] loading ChatterboxTurboTTS on {device}...", flush=True)
        _model = ChatterboxTurboTTS.from_pretrained(device=device)
        _ready = True
        print(f"[tts-sidecar] ready; voices: {list_voices()}", flush=True)
    except Exception as exc:
        _load_error = f"model load failed: {exc}"
        print(f"[tts-sidecar] startup failed: {_load_error}", flush=True)


def _cuda_available() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False
```

Also update the `/tts` handler's mock-voice branch — since real voices may now exist, the "mock" alias is only useful when there are no real voices. Replace the voice-validation block in the `/tts` handler with:

```python
    valid = list_voices()
    if voice not in valid:
        if voice == "mock" and not valid:
            # Allow mock when no real voices are present (smoke test before
            # the user runs generate_voices.py). Real model isn't required;
            # generate_audio handles its own readiness check.
            pass
        elif not valid:
            raise HTTPException(
                status_code=503,
                detail=(
                    f"no voices configured. Run `python tts_sidecar/generate_voices.py` "
                    f"to populate tts_sidecar/voices/."
                ),
            )
        else:
            raise HTTPException(status_code=404, detail=f"unknown voice: {voice}")
```

And replace the `generate_audio` invocation block in `/tts` to fall back to mock-silent when no model is loaded AND voice=="mock":

```python
    try:
        if voice == "mock" and _model is None:
            wav_bytes = make_silent_wav(1.0)
        else:
            wav_bytes = generate_audio(text, voice)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"generate failed: {exc}")
```

- [ ] **Step 3: Update test file to handle the new readiness states**

In `tts_sidecar/test_server.py`, the `client` fixture currently monkeypatches `_ready = True`. Add a monkeypatch for `_model = None` to match the new state shape and ensure tests still work without real torch:

In the `client` fixture (replace the existing version):

```python
@pytest.fixture
def client(monkeypatch, tmp_path):
    from tts_sidecar import server as srv

    voices_dir = tmp_path / "voices"
    voices_dir.mkdir()
    monkeypatch.setattr(srv, "VOICES_DIR", voices_dir)
    monkeypatch.setattr(srv, "_ready", True)
    monkeypatch.setattr(srv, "_model", None)  # tests don't load real model
    monkeypatch.setattr(srv, "_load_error", None)

    return TestClient(srv.app)
```

- [ ] **Step 4: Verify file structure (no Python runtime available)**

Smell-check the diff:
- Imports of `torch` and `chatterbox.tts_turbo` happen ONLY inside `on_startup`, not at module load. Good — TestClient can still import the module without torch.
- `_load_error` propagates from `on_startup` into the error message that `generate_audio` raises.
- `make_silent_wav` is still defined (used by the mock-fallback path).

If the diff looks clean, commit.

- [ ] **Step 5: Commit**

```bash
git add tts_sidecar/requirements.txt tts_sidecar/server.py tts_sidecar/test_server.py
git commit -m "feat(tts-sidecar): wire real ChatterboxTurboTTS model (loads on startup)"
```

---

## Task 4: `generate_voices.py` script

**Files:**
- Create: `tts_sidecar/generate_voices.py`

The one-shot script the USER runs to populate `tts_sidecar/voices/` with the three bundled reference clips. The subagent writes the script but does NOT run it.

- [ ] **Step 1: Create the script**

```python
"""One-shot script to generate the three bundled voice references.

Run once after installing tts_sidecar/requirements.txt:

    python tts_sidecar/generate_voices.py

Generates noir.wav, warm.wav, and crisp.wav into tts_sidecar/voices/.
Commit the resulting files to the repo so other developers don't need to
regenerate them.

Strategy: use Chatterbox-Turbo in default (no-reference) mode to synthesize
a 10-second seed clip for each character voice, with text that matches the
intended character. The model's default voice plus the text's prosody
combine to produce a distinctive seed reference. Subsequent /tts calls
use these as the audio_prompt_path for voice cloning.
"""

import sys
from pathlib import Path

VOICES_DIR = Path(__file__).parent / "voices"
VOICES_DIR.mkdir(exist_ok=True)


CHARACTERS = {
    "noir": (
        # Detective-noir cadence: short clipped sentences, dramatic pauses.
        "It was raining when I found the body. The kind of rain that doesn't "
        "wash anything away — it just makes you remember what you'd rather forget. "
        "She'd been waiting for me. I just didn't know it yet."
    ),
    "warm": (
        # Storyteller warmth: longer sentences, gentle inflection.
        "Long ago, in a quiet valley where the wind always carried the smell of "
        "woodsmoke, there lived a girl who could speak with the foxes. Every "
        "evening she walked to the edge of the forest and listened for them."
    ),
    "crisp": (
        # Crisp narrator: neutral, measured, mission-briefing tone.
        "The transport is scheduled to depart at oh-six-hundred. You will have "
        "exactly ninety seconds to board. Equipment checks are not optional. "
        "Any questions, ask them now. We don't get a second chance."
    ),
}


def main() -> int:
    try:
        import torchaudio as ta
        from chatterbox.tts_turbo import ChatterboxTurboTTS
    except ImportError as exc:
        print(f"missing dependency: {exc}", file=sys.stderr)
        print(
            "Install: pip install -r tts_sidecar/requirements.txt",
            file=sys.stderr,
        )
        return 1

    print("Loading ChatterboxTurboTTS on cuda (this will take a moment)...")
    model = ChatterboxTurboTTS.from_pretrained(device="cuda")

    for slug, text in CHARACTERS.items():
        out = VOICES_DIR / f"{slug}.wav"
        print(f"Generating {out}...")
        # No audio_prompt_path = use the model's default voice as the seed.
        # The text's character shapes the seed clip's prosody.
        wav = model.generate(text)
        ta.save(str(out), wav, model.sr)
        print(f"  wrote {out.stat().st_size} bytes")

    print("\nDone. Reference clips are in tts_sidecar/voices/.")
    print("Commit them to the repo:")
    print("  git add tts_sidecar/voices/*.wav")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Commit**

```bash
git add tts_sidecar/generate_voices.py
git commit -m "feat(tts-sidecar): generate_voices.py to bootstrap bundled reference clips"
```

---

## Task 5: `tts_sidecar/README.md`

**Files:**
- Create: `tts_sidecar/README.md`

Self-contained setup documentation for the Python side.

- [ ] **Step 1: Create the README**

```markdown
# TTS Sidecar

The narration backend for World Engine. A small FastAPI app wrapping
[ResembleAI Chatterbox Turbo](https://github.com/resemble-ai/chatterbox)
for self-hosted text-to-speech.

Bun (the game server) spawns this as a child process on startup. You
don't run it manually unless you're debugging.

## Setup (one-time)

You'll need Python 3.11+ and an NVIDIA GPU. CPU mode works but is ~10×
slower (not recommended for real-time narration).

```bash
# Recommended: a virtualenv just for this sidecar
python -m venv tts_sidecar/.venv
source tts_sidecar/.venv/bin/activate

pip install -r tts_sidecar/requirements.txt
```

The install pulls PyTorch 2.6 and Chatterbox Turbo. Roughly 5 GB of
disk space and 5-10 minutes on a decent connection. The model weights
download on first use (`from_pretrained` caches them in `~/.cache/`).

## Generate the bundled voice references (one-time)

```bash
python tts_sidecar/generate_voices.py
```

Creates `tts_sidecar/voices/noir.wav`, `warm.wav`, `crisp.wav`. These
are committed to the repo so other developers don't need to regenerate
them. Re-run the script if you bump Chatterbox versions and want to
regenerate to match.

## Running the sidecar manually

Bun normally spawns this for you. If you need to test it standalone:

```bash
source tts_sidecar/.venv/bin/activate
python tts_sidecar/server.py
```

Defaults: `127.0.0.1:5005`. Override via `TTS_SIDECAR_HOST` / `TTS_SIDECAR_PORT`.

## GPU memory

Chatterbox Turbo is 350M parameters, ~1.5 GB VRAM at fp32.

If you're also running LM Studio with NVIDIA-Nemotron-3-Nano (Q3_K_L, ~10 GB),
total VRAM use is ~12 GB — fits comfortably on a 16 GB GPU with headroom.

If you're tight on VRAM, the trade-offs are: smaller LM Studio model
(quants below Q3 lose noticeable quality), or run Chatterbox on CPU
(slow but functional).

## Watermarking

Every clip Chatterbox generates includes an imperceptible
[PerTh watermark](https://github.com/resemble-ai/perth). This is
Resemble AI's responsible-AI default — not removable, not configurable,
not audible. It exists so generated audio can be identified as
AI-generated by Resemble's detection tools. For a single-player game
this is harmless.

## Tests

```bash
source tts_sidecar/.venv/bin/activate
pytest tts_sidecar/test_server.py
```

Tests use FastAPI's `TestClient` and mock the Chatterbox model — they
run without GPU, without loading the real model, and complete in
under a second. The tests verify the HTTP shape, not the audio
quality.
```

- [ ] **Step 2: Commit**

```bash
git add tts_sidecar/README.md
git commit -m "docs(tts-sidecar): setup, voice generation, GPU and watermark notes"
```

---

## Task 6: `src/sidecar.ts` — Bun-side process lifecycle

**Files:**
- Create: `src/sidecar.ts`
- Create: `src/sidecar.test.ts`

Bun spawns the Python child, polls /health until ready, exposes `narrationReady`. Signal forwarding so killing Bun kills the child.

- [ ] **Step 1: Write the failing test**

Create `src/sidecar.test.ts`:

```typescript
import { test, expect, describe, beforeEach, mock } from "bun:test";

// Module under test is loaded lazily inside tests so we can mock dependencies first.

describe("sidecar", () => {
  beforeEach(() => {
    mock.module("./sidecar", () => {
      const original = require("./sidecar");
      return { ...original };
    });
  });

  test("isNarrationReady starts false before sidecar boots", async () => {
    const { isNarrationReady, resetSidecarStateForTesting } = await import("./sidecar");
    resetSidecarStateForTesting();
    expect(isNarrationReady()).toBe(false);
  });

  test("waitForSidecarReady resolves true when /health reports ready", async () => {
    const { waitForSidecarReady, resetSidecarStateForTesting } = await import("./sidecar");
    resetSidecarStateForTesting();

    const origFetch = globalThis.fetch;
    let calls = 0;
    (globalThis as any).fetch = async (url: string) => {
      calls++;
      // First two calls report ready:false, third reports true (simulate model load)
      const ready = calls >= 3;
      return new Response(JSON.stringify({ ready, voices: ["noir"] }), { status: 200 });
    };

    try {
      const result = await waitForSidecarReady(5000, 50);
      expect(result).toBe(true);
      expect(calls).toBeGreaterThanOrEqual(3);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("waitForSidecarReady resolves false on timeout", async () => {
    const { waitForSidecarReady, resetSidecarStateForTesting } = await import("./sidecar");
    resetSidecarStateForTesting();

    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ ready: false, voices: [] }), { status: 200 });

    try {
      const result = await waitForSidecarReady(200, 50);
      expect(result).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("waitForSidecarReady handles fetch errors gracefully (keeps retrying)", async () => {
    const { waitForSidecarReady, resetSidecarStateForTesting } = await import("./sidecar");
    resetSidecarStateForTesting();

    const origFetch = globalThis.fetch;
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ ready: true, voices: ["noir"] }), { status: 200 });
    };

    try {
      const result = await waitForSidecarReady(5000, 50);
      expect(result).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("isNarrationReady reflects markSidecarReady", async () => {
    const { isNarrationReady, markSidecarReady, resetSidecarStateForTesting } = await import("./sidecar");
    resetSidecarStateForTesting();
    expect(isNarrationReady()).toBe(false);
    markSidecarReady(true);
    expect(isNarrationReady()).toBe(true);
    markSidecarReady(false);
    expect(isNarrationReady()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, confirm they fail with module-not-found**

Run: `bun test src/sidecar.test.ts`
Expected: failure due to `./sidecar` not existing.

- [ ] **Step 3: Implement `src/sidecar.ts`**

```typescript
/**
 * Lifecycle for the Python TTS sidecar process.
 *
 * - spawnSidecar() launches `python3 tts_sidecar/server.py` as a Bun child.
 * - waitForSidecarReady() polls /health until ready:true or timeout.
 * - markSidecarReady() flips an internal flag (also called by waitForSidecarReady).
 * - isNarrationReady() exposes the flag to the rest of the server.
 * - SIGINT/SIGTERM on the Bun process kill the Python child cleanly.
 */

import type { Subprocess } from "bun";

const SIDECAR_HOST = process.env.TTS_SIDECAR_HOST ?? "127.0.0.1";
const SIDECAR_PORT = process.env.TTS_SIDECAR_PORT ?? "5005";
export const SIDECAR_BASE_URL = `http://${SIDECAR_HOST}:${SIDECAR_PORT}`;

let _ready = false;
let _process: Subprocess | null = null;

export function isNarrationReady(): boolean {
  return _ready;
}

export function markSidecarReady(ready: boolean): void {
  _ready = ready;
}

/** Tests-only escape hatch. */
export function resetSidecarStateForTesting(): void {
  _ready = false;
  _process = null;
}

/**
 * Spawn the Python sidecar as a child of this Bun process. Stdout/stderr
 * are forwarded to the Bun console with a [tts-sidecar] prefix.
 *
 * Does not wait for readiness — call waitForSidecarReady() after.
 */
export function spawnSidecar(): Subprocess {
  if (_process) return _process;

  const proc = Bun.spawn(["python3", "tts_sidecar/server.py"], {
    env: { ...process.env, TTS_SIDECAR_HOST: SIDECAR_HOST, TTS_SIDECAR_PORT: SIDECAR_PORT },
    stdout: "pipe",
    stderr: "pipe",
  });

  _process = proc;
  pipeWithPrefix(proc.stdout, "[tts-sidecar]");
  pipeWithPrefix(proc.stderr, "[tts-sidecar]");

  // Make sure the child dies when Bun dies.
  const onExit = () => {
    if (_process && _process.exitCode === null) {
      _process.kill("SIGTERM");
    }
  };
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);
  process.on("exit", onExit);

  return proc;
}

async function pipeWithPrefix(stream: ReadableStream<Uint8Array> | undefined, prefix: string): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) console.log(`${prefix} ${line}`);
    }
  }
  if (buf.length > 0) console.log(`${prefix} ${buf}`);
}

/**
 * Poll /health until ready:true, or until timeoutMs elapses.
 *
 * Returns true on success, false on timeout. Resilient to fetch errors
 * (the sidecar isn't listening yet during the first few hundred ms).
 *
 * @param timeoutMs - hard timeout (ms). Default 15s, model load typically 5-10s.
 * @param intervalMs - poll interval. Default 250ms.
 */
export async function waitForSidecarReady(
  timeoutMs = 15_000,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${SIDECAR_BASE_URL}/health`);
      if (res.ok) {
        const body = (await res.json()) as { ready: boolean; voices: string[] };
        if (body.ready) {
          markSidecarReady(true);
          return true;
        }
      }
    } catch {
      // Sidecar not listening yet; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/** Fetch the voice list from the sidecar. Empty array on any failure. */
export async function listSidecarVoices(): Promise<string[]> {
  try {
    const res = await fetch(`${SIDECAR_BASE_URL}/health`);
    if (!res.ok) return [];
    const body = (await res.json()) as { voices: string[] };
    return body.voices ?? [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `bun test src/sidecar.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sidecar.ts src/sidecar.test.ts
git commit -m "feat(sidecar): spawn Python TTS child + health polling + signal forwarding"
```

---

## Task 7: `src/tts.ts` — Bun-side TTS client with disk cache

**Files:**
- Create: `src/tts.ts`
- Create: `src/tts.test.ts`

Synthesize audio via the sidecar, hash the (text, voice) pair, cache on disk, return the public URL.

- [ ] **Step 1: Write the failing test**

Create `src/tts.test.ts`:

```typescript
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("synthesizeToFile", () => {
  let tmpRoot: string;
  let origMediaRoot: string | undefined;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "tts-test-"));
    origMediaRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = tmpRoot;
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origMediaRoot === undefined) {
      delete process.env.MEDIA_ROOT;
    } else {
      process.env.MEDIA_ROOT = origMediaRoot;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("first call: posts to sidecar, writes file, returns URL path", async () => {
    let postCalls = 0;
    (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
      postCalls++;
      if (init?.method === "POST") {
        return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x02]), {
          status: 200,
          headers: { "content-type": "audio/wav" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const { synthesizeToFile } = await import("./tts");
    const url = await synthesizeToFile("hello world", "noir");

    expect(url).toMatch(/^\/media\/audio\/[0-9a-f]{16}\.wav$/);
    const filePath = join(tmpRoot, "audio", url.replace("/media/audio/", ""));
    expect(existsSync(filePath)).toBe(true);
    expect(postCalls).toBe(1);
  });

  test("second call with same text+voice: skips sidecar, returns same URL", async () => {
    let postCalls = 0;
    (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        postCalls++;
        return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
          status: 200,
          headers: { "content-type": "audio/wav" },
        });
      }
      throw new Error("unexpected GET");
    };

    const { synthesizeToFile } = await import("./tts");
    const url1 = await synthesizeToFile("hello world", "noir");
    const url2 = await synthesizeToFile("hello world", "noir");

    expect(url1).toBe(url2);
    expect(postCalls).toBe(1);
  });

  test("different voice = different hash = different file", async () => {
    (globalThis as any).fetch = async () =>
      new Response(new Uint8Array([0x52]), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });

    const { synthesizeToFile } = await import("./tts");
    const url1 = await synthesizeToFile("hello", "noir");
    const url2 = await synthesizeToFile("hello", "warm");

    expect(url1).not.toBe(url2);
  });

  test("different text = different hash = different file", async () => {
    (globalThis as any).fetch = async () =>
      new Response(new Uint8Array([0x52]), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });

    const { synthesizeToFile } = await import("./tts");
    const url1 = await synthesizeToFile("hello", "noir");
    const url2 = await synthesizeToFile("goodbye", "noir");

    expect(url1).not.toBe(url2);
  });

  test("sidecar 500: throws with the error detail", async () => {
    (globalThis as any).fetch = async () =>
      new Response("model crashed", { status: 500 });

    const { synthesizeToFile } = await import("./tts");
    await expect(synthesizeToFile("hello", "noir")).rejects.toThrow(/500/);
  });

  test("pre-existing cached file: skips sidecar entirely", async () => {
    // Pre-seed the cache so the first call is a hit.
    const { _hashForTesting } = await import("./tts");
    const hash = _hashForTesting("hello world", "noir");
    const audioDir = join(tmpRoot, "audio");
    require("node:fs").mkdirSync(audioDir, { recursive: true });
    writeFileSync(join(audioDir, `${hash}.wav`), new Uint8Array([0xab]));

    let postCalls = 0;
    (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") postCalls++;
      return new Response(new Uint8Array([0]), { status: 200 });
    };

    const { synthesizeToFile } = await import("./tts");
    const url = await synthesizeToFile("hello world", "noir");
    expect(url).toBe(`/media/audio/${hash}.wav`);
    expect(postCalls).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests, confirm module-not-found failure**

Run: `bun test src/tts.test.ts`
Expected: fail (no `./tts` module).

- [ ] **Step 3: Implement `src/tts.ts`**

```typescript
/**
 * Bun-side TTS client.
 *
 * synthesizeToFile is the only entry point. It:
 *   1. Computes a content hash of (text, voice).
 *   2. Checks if media/audio/<hash>.wav already exists.
 *   3. If not, POSTs the text to the sidecar and writes the response.
 *   4. Returns the public URL path the frontend uses for <audio src>.
 *
 * The cache survives server restarts (it's on disk). Same narrative +
 * same voice always maps to the same file across sessions.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SIDECAR_BASE_URL } from "./sidecar";

function mediaRoot(): string {
  // MEDIA_ROOT is honored for tests; production resolves relative to the repo.
  return process.env.MEDIA_ROOT ?? new URL("../media", import.meta.url).pathname;
}

function audioDir(): string {
  const dir = join(mediaRoot(), "audio");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Hash key for cached audio: first 16 chars of sha256(text + voice). */
export function _hashForTesting(text: string, voice: string): string {
  return createHash("sha256").update(`${voice} ${text}`).digest("hex").slice(0, 16);
}

/**
 * Returns the public URL path of a WAV file for (text, voice). Generates
 * via the sidecar on cache miss.
 *
 * @throws if the sidecar returns non-2xx.
 */
export async function synthesizeToFile(text: string, voice: string): Promise<string> {
  const hash = _hashForTesting(text, voice);
  const filename = `${hash}.wav`;
  const filePath = join(audioDir(), filename);
  const urlPath = `/media/audio/${filename}`;

  if (existsSync(filePath)) {
    return urlPath;
  }

  const res = await fetch(`${SIDECAR_BASE_URL}/tts?voice=${encodeURIComponent(voice)}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: text,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`sidecar /tts ${res.status}: ${detail.slice(0, 200)}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(filePath, bytes);
  return urlPath;
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `bun test src/tts.test.ts`
Expected: all 6 tests pass.

- [ ] **Step 5: Run full suite, confirm no regressions**

Run: `bun test`
Expected: existing tests still pass. New tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/tts.ts src/tts.test.ts
git commit -m "feat(tts): synthesizeToFile with sha256-keyed disk cache"
```

---

## Task 8: Update `src/config.ts` — add `useNarration`, drop `useGeminiNarration`

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`

The Gemini-narration flag is dropping out. The new flag is single-purpose: should Bun spawn the sidecar at all?

- [ ] **Step 1: Update the `Config` type in `src/config.ts`**

Find:
```typescript
export type Config = {
  ...
  useGeminiImages: boolean;
  useGeminiNarration: boolean;
};
```

Replace with:
```typescript
export type Config = {
  ...
  useGeminiImages: boolean;
  useNarration: boolean;
};
```

- [ ] **Step 2: Update `parseConfig` to populate `useNarration`**

Find the section in `parseConfig` that handles `useGeminiNarration`:
```typescript
  const useGeminiImages = parseBool(env.USE_GEMINI_IMAGES);
  const useGeminiNarration = parseBool(env.USE_GEMINI_NARRATION);
```

Replace with:
```typescript
  const useGeminiImages = parseBool(env.USE_GEMINI_IMAGES);
  // USE_NARRATION defaults to true (narration enabled when sidecar can run).
  // Set USE_NARRATION=false to skip spawning the Python sidecar entirely.
  const useNarration = env.USE_NARRATION === undefined
    ? true
    : env.USE_NARRATION.trim().toLowerCase() === "true";
```

Find the cross-validation block:
```typescript
  if (useGeminiNarration && (env.GEMINI_API_KEY ?? "") === "") {
    errors.push(
      "USE_GEMINI_NARRATION=true but GEMINI_API_KEY is empty. Get a key at https://aistudio.google.com/app/api-keys.",
    );
  }
```

Delete that block entirely (narration no longer depends on Gemini).

Find the return statement's config object and replace `useGeminiNarration` with `useNarration`:

```typescript
      useGeminiImages,
      useNarration,
```

- [ ] **Step 3: Update the ENV_KEYS array in `src/config.test.ts`**

Find:
```typescript
const ENV_KEYS = [
  ...
  "USE_GEMINI_IMAGES",
  "USE_GEMINI_NARRATION",
  ...
];
```

Replace `"USE_GEMINI_NARRATION"` with `"USE_NARRATION"`:
```typescript
const ENV_KEYS = [
  ...
  "USE_GEMINI_IMAGES",
  "USE_NARRATION",
  ...
];
```

- [ ] **Step 4: Update tests in `src/config.test.ts`**

The "shape" test currently checks `useGeminiNarration: false`. Update it to assert the new default of `useNarration: true`:

Find:
```typescript
    expect(result.config.useGeminiImages).toBe(false);
    expect(result.config.useGeminiNarration).toBe(false);
```

Replace with:
```typescript
    expect(result.config.useGeminiImages).toBe(false);
    expect(result.config.useNarration).toBe(true);
```

Find the entire `describe("parseConfig — booleans", ...)` block. The two `useGeminiNarration` test cases must be rewritten to test `useNarration` semantics (defaults to true, USE_NARRATION=false makes it false).

Replace the whole `describe("parseConfig — booleans", ...)` block with:

```typescript
describe("parseConfig — booleans", () => {
  test("USE_GEMINI_IMAGES=\"true\" is true", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "local,m",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
      USE_GEMINI_IMAGES: "true",
      GEMINI_API_KEY: "k",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.useGeminiImages).toBe(true);
  });

  test("USE_GEMINI_IMAGES is case-insensitive on true", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "local,m",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
      USE_GEMINI_IMAGES: "TRUE",
      GEMINI_API_KEY: "k",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.useGeminiImages).toBe(true);
  });

  test("USE_NARRATION defaults to true when unset", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "local,m",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.useNarration).toBe(true);
  });

  test("USE_NARRATION=\"false\" disables narration", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "local,m",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
      USE_NARRATION: "false",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.useNarration).toBe(false);
  });

  test("USE_NARRATION non-true values are treated as true (only false disables)", () => {
    // USE_NARRATION defaults to ON. Anything not literally "false" leaves it on.
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "local,m",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
      USE_NARRATION: "yes",  // not "false", so still true
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.useNarration).toBe(true);
  });
});
```

- [ ] **Step 5: Update cross-validation test**

In `describe("parseConfig — cross-validation", ...)`, find the test `"USE_GEMINI_NARRATION=true requires GEMINI_API_KEY"`. Delete it entirely — the cross-validation no longer exists.

Also update the "multiple validation errors" test if it references USE_GEMINI_NARRATION. Find:

```typescript
  test("multiple validation errors are all returned, not just the first", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "openrouter,m",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
      USE_GEMINI_IMAGES: "true",
      USE_GEMINI_NARRATION: "true",
    }));
```

Replace with:

```typescript
  test("multiple validation errors are all returned, not just the first", () => {
    const r = parseConfig(makeEnv({
      NARRATOR_PROVIDER: "openrouter,m",
      ARCHIVIST_PROVIDER: "local,m",
      INTERPRETER_PROVIDER: "local,m",
      USE_GEMINI_IMAGES: "true",
    }));
```

And update the assertion's expected error count (now 1 error each — openrouter missing key + gemini images missing key):

```typescript
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
    expect(r.errors.some((e) => e.includes("OPENROUTER_API_KEY is empty"))).toBe(true);
    expect(r.errors.some((e) => e.includes("USE_GEMINI_IMAGES=true but GEMINI_API_KEY"))).toBe(true);
```

(Assertions unchanged — `useGeminiNarration` was the one we deleted from the inputs.)

- [ ] **Step 6: Run tests, confirm pass**

Run: `bun test src/config.test.ts`
Expected: all config tests pass with the new shape.

- [ ] **Step 7: Run full test suite**

Run: `bun test`
Expected: config tests pass. SERVER tests will fail because `server.ts` still references `useGeminiNarration` — that's Task 9. Document the failure count, expect it to be small (1-3 in server.test.ts).

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat(config): replace useGeminiNarration with useNarration (defaults true)"
```

---

## Task 9: Update `src/server.ts` — spawn sidecar, emit `audio-ready`, drop audio-chunk path

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

The cutover. server.ts boots the sidecar, the WS protocol replaces `audio-start`/`chunk`/`end` with a single `audio-ready` message, the snapshot includes `narrationReady`, and the WS-side TTS gate is rebuilt around `useNarration`.

- [ ] **Step 1: Update imports in `src/server.ts`**

Find:
```typescript
import { synthesizeStream, GEMINI_VOICES, DEFAULT_VOICE } from "./gemini-tts";
```

Replace with:
```typescript
import { synthesizeToFile } from "./tts";
import { spawnSidecar, waitForSidecarReady, isNarrationReady, listSidecarVoices } from "./sidecar";
```

The `GEMINI_VOICES` / `DEFAULT_VOICE` constants are gone. Define a placeholder in server.ts so existing references (snapshot's `providers.tts.voice`) keep type-checking until we update them in this same task:

Add near the top of `src/server.ts` (just below the imports):

```typescript
// Default voice slug — must exist in tts_sidecar/voices/ after the user runs
// generate_voices.py. The runtime voice list is fetched from the sidecar.
const DEFAULT_VOICE = "noir";
```

- [ ] **Step 2: Update the `ServerMessage` discriminated union**

Find:
```typescript
  | { type: "audio-start" }
  | { type: "audio-chunk"; data: string }
  | { type: "audio-end" }
```

Replace with:
```typescript
  | { type: "audio-ready"; turnId: number; url: string }
  | { type: "audio-error"; turnId: number; message: string }
```

- [ ] **Step 3: Update the `ProviderInfo` interface**

Find:
```typescript
export interface ProviderInfo {
  ...
  useGeminiImages: boolean;
  useGeminiNarration: boolean;
}
```

Replace with:
```typescript
export interface ProviderInfo {
  ...
  useGeminiImages: boolean;
  useNarration: boolean;
  narrationReady: boolean;
  voices: string[];
}
```

- [ ] **Step 4: Update `providerInfo()` helper**

Find the function:
```typescript
function providerInfo(): ProviderInfo {
  return {
    ...
    useGeminiImages: getServerConfig().useGeminiImages,
    useGeminiNarration: getServerConfig().useGeminiNarration,
  };
}
```

Replace its body with:
```typescript
function providerInfo(): ProviderInfo {
  const c = getServerConfig();
  return {
    narrator: { provider: c.narrator.provider, model: c.narrator.model },
    archivist: { model: c.archivist.model },
    interpreter: { provider: c.interpreter.provider, model: c.interpreter.model },
    tts: { provider: "chatterbox", voice: _voiceList[0] ?? DEFAULT_VOICE },
    image: { provider: "gemini", style: DEFAULT_IMAGE_STYLE },
    useGeminiImages: c.useGeminiImages,
    useNarration: c.useNarration,
    narrationReady: isNarrationReady(),
    voices: _voiceList,
  };
}
```

And add a module-level cache for the voice list (populated when the sidecar becomes ready):

```typescript
let _voiceList: string[] = [];
```

- [ ] **Step 5: Update the TTS streaming block in `processInput`**

Find the existing block that calls `synthesizeStream` and pushes `audio-chunk` messages (the whole `const ttsPromise: Promise<void> = voice && sendAudio ...` block).

Replace it with:

```typescript
  // Generate (or cache-hit) the WAV file, then notify the originating client.
  // Runs in parallel with the archivist call below.
  const ttsPromise: Promise<void> = voice && sendAudio && getServerConfig().useNarration && isNarrationReady()
    ? (async () => {
        try {
          const url = await synthesizeToFile(narrative, voice);
          // NOTE: turnId is the archivist's resulting turn number, which we don't
          // know yet at this point. Send the URL keyed by the input echo + the
          // narrative hash — the client maps it via the latest pending turn.
          // Simpler: omit turnId here, let the client attach to the most recent turn.
          sendAudio({ type: "audio-ready", turnId: stack.turn + 1, url });
        } catch (err) {
          console.error("[tts]", err);
          sendAudio({
            type: "audio-error",
            turnId: stack.turn + 1,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })()
    : Promise.resolve();
```

- [ ] **Step 6: Update `main()` to spawn the sidecar**

Find the `main()` function. After `loadConfig()` + `logStartupRouting()`, add the sidecar boot:

```typescript
  if (serverConfig.useNarration) {
    console.log("[tts] spawning sidecar...");
    spawnSidecar();
    // Fire-and-forget — the server starts listening immediately; narration
    // becomes available once the sidecar reports ready.
    waitForSidecarReady().then(async (ready) => {
      if (ready) {
        _voiceList = await listSidecarVoices();
        console.log(`[tts] sidecar ready, voices: ${_voiceList.join(", ") || "(none — run generate_voices.py)"}`);
      } else {
        console.warn("[tts] sidecar did not become ready within timeout — narration disabled");
      }
    });
  } else {
    console.log("[tts] USE_NARRATION=false — sidecar not started, narration disabled");
  }
```

- [ ] **Step 7: Update `/api/voices` route**

Find the existing route (around line 483-491 — verify with grep before editing):

```typescript
      if (url.pathname === "/api/voices" && req.method === "GET") {
        if (!getServerConfig().useGeminiNarration) {
          return new Response("USE_GEMINI_NARRATION=false", { status: 503 });
        }
        return Response.json({ voices: GEMINI_VOICES, default: DEFAULT_VOICE });
      }
```

Replace with:

```typescript
      if (url.pathname === "/api/voices" && req.method === "GET") {
        if (!getServerConfig().useNarration) {
          return new Response("USE_NARRATION=false", { status: 503 });
        }
        if (!isNarrationReady()) {
          return new Response("sidecar warming up", { status: 503 });
        }
        return Response.json({ voices: _voiceList, default: _voiceList[0] ?? DEFAULT_VOICE });
      }
```

- [ ] **Step 8: Delete the `/api/speak` route entirely**

Find the `/api/speak` route block and delete it. The new architecture doesn't need an HTTP endpoint for TTS — the WebSocket `audio-ready` message tells the client where to find the file, and the file is served via the existing `/media/...` static route.

- [ ] **Step 9: Update `src/server.test.ts`**

Find the test added during the audio refactor: `"processInput: TTS audio messages go through sendAudio (unicast), not send (broadcast)"`. The shape changed — it now emits `audio-ready` (not `audio-start/chunk/end`).

Replace that test entirely with:

```typescript
test("processInput: TTS audio-ready message goes through sendAudio (unicast), not send (broadcast)", async () => {
  // Need a working sidecar + isNarrationReady for the gate.
  process.env.USE_NARRATION = "true";
  process.env.NARRATOR_PROVIDER = "local,test-model";
  process.env.ARCHIVIST_PROVIDER = "local,test-model";
  process.env.INTERPRETER_PROVIDER = "local,test-model";

  const { resetConfigForTesting } = await import("./api");
  const { resetServerConfigForTesting } = await import("./server");
  const { resetSidecarStateForTesting, markSidecarReady } = await import("./sidecar");
  resetConfigForTesting();
  resetServerConfigForTesting();
  resetSidecarStateForTesting();
  markSidecarReady(true);

  // Mock synthesizeToFile to return a known URL without actually calling the sidecar.
  const ttsModule = await import("./tts");
  const origSynth = ttsModule.synthesizeToFile;
  (ttsModule as any).synthesizeToFile = async (_text: string, _voice: string) => "/media/audio/abc123.wav";

  try {
    const { processInput } = await import("./server");
    const engine = await import("./engine");
    const interp = await import("./engine");

    spyOn(interp, "interpreterTurn").mockResolvedValue({ action: "stay" } as any);
    spyOn(engine, "narratorTurn").mockResolvedValue("Narration.");
    spyOn(engine, "archivistTurn").mockResolvedValue({
      entries: [], threads: [], turn: 1, moved: false,
      locationDescription: "", achievedObjectiveIndices: [],
    } as any);

    const broadcasts: any[] = [];
    const unicasts: any[] = [];
    const baseStack: any = {
      entries: [], threads: [], turn: 0, position: [0, 0],
      places: {}, objectives: [], presetSlug: null,
    };

    await processInput(
      baseStack,
      "look",
      (m) => broadcasts.push(m),
      undefined,
      "noir",
      (m) => unicasts.push(m),
    );

    const audioOnBroadcast = broadcasts.filter((m) => m.type === "audio-ready");
    const audioOnUnicast = unicasts.filter((m) => m.type === "audio-ready");
    expect(audioOnBroadcast).toEqual([]);
    expect(audioOnUnicast.length).toBe(1);
    expect(audioOnUnicast[0]).toEqual({
      type: "audio-ready",
      turnId: 1,
      url: "/media/audio/abc123.wav",
    });
  } finally {
    (ttsModule as any).synthesizeToFile = origSynth;
  }
});
```

The other existing tests in server.test.ts that touched `useGeminiNarration` (e.g., snapshot field assertions) need updating too. Find any assertion of `useGeminiNarration` and replace with `useNarration` (asserting it equals `true` by default, since we changed the default).

- [ ] **Step 10: Run full test suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat(server): spawn TTS sidecar at boot, emit audio-ready WS, drop chunk path"
```

---

## Task 10: Rewrite `src/web/playback-controller.ts` for `<audio>` element coordination

**Files:**
- Modify: `src/web/playback-controller.ts`
- Modify: `src/web/playback-controller.test.ts`

Strip out the streaming-PCM machinery. The controller becomes a coordinator around a single `<audio>` element.

- [ ] **Step 1: Replace `src/web/playback-controller.ts` entirely**

The new file (replace ALL contents):

```typescript
/**
 * Coordinates the single audio element across turns.
 *
 * The frontend only ever has one HTMLAudioElement being commanded at a time;
 * this class owns its lifecycle:
 *   - play(turnId, url): pause whatever was playing, point the element at
 *     the new URL, start playback.
 *   - abortCurrent(): pause.
 *   - setVoice(voice): voice change wipes the current playback (the audio
 *     was for the old voice; future turns will get fresh URLs).
 *   - setEnabled(on): when off, pause immediately.
 *   - isAudible(): true if the element is currently playing.
 *
 * No Web Audio API. No AudioContext. No buffer sources. Volume is set
 * directly on the audio element.
 */

export type ControllerState = "idle" | "playing";

export class PlaybackController {
  private _state: ControllerState = "idle";
  private _currentTurnId: number | null = null;
  private _element: HTMLAudioElement | null = null;
  private _enabled = true;
  private _volume = 1.0;

  get state(): ControllerState { return this._state; }
  get currentTurnId(): number | null { return this._currentTurnId; }

  /**
   * Attach the (single) audio element this controller commands.
   * Called once after React renders <audio ref={...} />.
   */
  attachElement(el: HTMLAudioElement | null): void {
    this._element = el;
    if (el) {
      el.volume = this._volume;
      el.addEventListener("ended", () => this.onEnded());
      el.addEventListener("error", () => this.onEnded());
    }
  }

  private onEnded(): void {
    this._state = "idle";
    this._currentTurnId = null;
  }

  /** Play a URL for a turn. Pauses any prior playback first. */
  async play(turnId: number, url: string): Promise<void> {
    if (!this._enabled) return;
    const el = this._element;
    if (!el) return;
    try {
      el.pause();
    } catch { /* ignore */ }
    el.src = url;
    el.currentTime = 0;
    this._state = "playing";
    this._currentTurnId = turnId;
    try {
      await el.play();
    } catch (err) {
      // Autoplay restrictions or src errors — fall back to idle.
      this._state = "idle";
      this._currentTurnId = null;
      if ((err as Error)?.name !== "NotAllowedError") {
        console.warn("[narration] play failed", err);
      }
    }
  }

  abortCurrent(): void {
    const el = this._element;
    if (el) {
      try { el.pause(); } catch { /* ignore */ }
    }
    this._state = "idle";
    this._currentTurnId = null;
  }

  setVoice(_voice: string): void {
    // Voice change → cached audio is for the wrong voice; stop now,
    // future turns will get fresh URLs from the server.
    this.abortCurrent();
  }

  setEnabled(on: boolean): void {
    this._enabled = on;
    if (!on) this.abortCurrent();
  }

  setVolume(v: number): void {
    this._volume = v;
    if (this._element) this._element.volume = v;
  }

  isAudible(): boolean {
    if (!this._element) return false;
    return !this._element.paused;
  }
}
```

- [ ] **Step 2: Replace `src/web/playback-controller.test.ts` entirely**

```typescript
import { test, expect, describe, beforeEach } from "bun:test";
import { PlaybackController } from "./playback-controller";

// Minimal fake of HTMLAudioElement — enough surface for the controller.
function makeFakeAudio() {
  const listeners: Record<string, Array<() => void>> = {};
  const el: any = {
    src: "",
    currentTime: 0,
    volume: 1,
    paused: true,
    pause() { el.paused = true; },
    async play() { el.paused = false; },
    addEventListener(name: string, fn: () => void) {
      (listeners[name] ??= []).push(fn);
    },
    fire(name: string) { (listeners[name] ?? []).forEach((fn) => fn()); },
  };
  return el as HTMLAudioElement & { fire: (name: string) => void };
}

describe("PlaybackController", () => {
  let pc: PlaybackController;
  let el: ReturnType<typeof makeFakeAudio>;

  beforeEach(() => {
    pc = new PlaybackController();
    el = makeFakeAudio();
    pc.attachElement(el);
  });

  test("starts idle", () => {
    expect(pc.state).toBe("idle");
    expect(pc.currentTurnId).toBeNull();
    expect(pc.isAudible()).toBe(false);
  });

  test("play(turn, url) sets src and starts playback", async () => {
    await pc.play(1, "/media/audio/abc.wav");
    expect(el.src).toBe("/media/audio/abc.wav");
    expect(el.paused).toBe(false);
    expect(pc.state).toBe("playing");
    expect(pc.currentTurnId).toBe(1);
    expect(pc.isAudible()).toBe(true);
  });

  test("play() while already playing: pauses prior then plays new", async () => {
    await pc.play(1, "/a.wav");
    await pc.play(2, "/b.wav");
    expect(el.src).toBe("/b.wav");
    expect(el.currentTime).toBe(0);
    expect(pc.currentTurnId).toBe(2);
  });

  test("abortCurrent() pauses + returns to idle", async () => {
    await pc.play(1, "/a.wav");
    pc.abortCurrent();
    expect(el.paused).toBe(true);
    expect(pc.state).toBe("idle");
    expect(pc.currentTurnId).toBeNull();
  });

  test("setVoice() aborts current", async () => {
    await pc.play(1, "/a.wav");
    pc.setVoice("warm");
    expect(el.paused).toBe(true);
    expect(pc.state).toBe("idle");
  });

  test("setEnabled(false) aborts and blocks future play", async () => {
    await pc.play(1, "/a.wav");
    pc.setEnabled(false);
    expect(el.paused).toBe(true);
    expect(pc.state).toBe("idle");
    await pc.play(2, "/b.wav");
    // setEnabled(false) means play is a no-op until re-enabled
    expect(pc.state).toBe("idle");
    expect(pc.currentTurnId).toBeNull();
  });

  test("setEnabled(true) restores play", async () => {
    pc.setEnabled(false);
    pc.setEnabled(true);
    await pc.play(1, "/a.wav");
    expect(pc.state).toBe("playing");
  });

  test("ended event from element returns to idle", async () => {
    await pc.play(1, "/a.wav");
    el.fire("ended");
    expect(pc.state).toBe("idle");
    expect(pc.currentTurnId).toBeNull();
  });

  test("setVolume sets the element volume immediately", () => {
    pc.setVolume(0.5);
    expect(el.volume).toBe(0.5);
  });
});
```

- [ ] **Step 3: Run controller tests, confirm pass**

Run: `bun test src/web/playback-controller.test.ts`
Expected: all 9 tests pass.

- [ ] **Step 4: Run full suite**

Run: `bun test`
Expected: app.tsx may still reference `audio-chunk` shape — that's Task 11. Other tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/web/playback-controller.ts src/web/playback-controller.test.ts
git commit -m "refactor(playback): slim controller to <audio> element coordination"
```

---

## Task 11: Update `src/web/app.tsx` for the new `audio-ready` message

**Files:**
- Modify: `src/web/app.tsx`

The frontend drops `audio-start/chunk/end` handlers, gains an `audio-ready` handler, attaches a single `<audio>` element to the new controller, and simplifies speaker-click logic.

- [ ] **Step 1: Update the `ServerMessage` type in app.tsx**

Find the type definition (around line 72-99). Update the audio-related branches:

Find:
```typescript
  | { type: "audio-start" }
  | { type: "audio-chunk"; data: string }
  | { type: "audio-end" }
```

Replace with:
```typescript
  | { type: "audio-ready"; turnId: number; url: string }
  | { type: "audio-error"; turnId: number; message: string }
```

- [ ] **Step 2: Update the `ProviderInfo` type in app.tsx**

Find:
```typescript
type ProviderInfo = {
  ...
  useGeminiImages: boolean;
  useGeminiNarration: boolean;
};
```

Replace with:
```typescript
type ProviderInfo = {
  ...
  useGeminiImages: boolean;
  useNarration: boolean;
  narrationReady: boolean;
  voices: string[];
};
```

- [ ] **Step 3: Update the WebSocket handler block**

Find the three branches that handle audio messages (`if (msg.type === "audio-start")`, `if (msg.type === "audio-chunk")`, `if (msg.type === "audio-end")`).

Delete all three. Replace with:

```typescript
      if (msg.type === "audio-ready") {
        setAudioByTurn((prev) => ({ ...prev, [msg.turnId]: msg.url }));
        if (narrationOnRef.current) {
          playbackRef.current?.play(msg.turnId, msg.url);
        }
        return;
      }
      if (msg.type === "audio-error") {
        // Log it, but don't break the turn — the narrative is already on screen.
        console.warn("[narration]", msg.message);
        return;
      }
```

- [ ] **Step 4: Replace the audio element infrastructure**

The current app.tsx instantiates a `TTSEngine` and references `ttsRef.current.startStream/addChunk/endStream`. Delete the `ttsRef` and its instantiation.

Find:
```typescript
  const ttsRef = useRef<TTSEngine | null>(null);
  if (!ttsRef.current) ttsRef.current = new TTSEngine(setEngineStatus);
  const playbackRef = useRef<PlaybackController | null>(null);
  if (!playbackRef.current) playbackRef.current = new PlaybackController(ttsRef.current);
```

Replace with:
```typescript
  const playbackRef = useRef<PlaybackController | null>(null);
  if (!playbackRef.current) playbackRef.current = new PlaybackController();
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
```

- [ ] **Step 5: Attach the audio element to the controller**

Add a useEffect to attach the element after mount:

```typescript
  useEffect(() => {
    playbackRef.current?.attachElement(audioElementRef.current);
  }, []);
```

- [ ] **Step 6: Add the single `<audio>` element to the rendered tree**

Just inside the `App` component's top-level `<div>` (right after the root div opens, before any content), add:

```jsx
      <audio ref={audioElementRef} preload="auto" />
```

This single element is what the controller commands. The existing per-turn `<audio>` elements inside TurnBlock / SystemBlock get deleted in the next step.

- [ ] **Step 7: Remove per-turn `<audio>` elements from `TurnBlock` and `SystemBlock`**

In `TurnBlock`, find:
```jsx
        {audioUrl && <audio ref={audioRef} src={audioUrl} preload="auto" />}
```

Delete that line. Also delete the `const audioRef = useRef<HTMLAudioElement | null>(null);` and the `useEffect` that wires volume on `audioRef.current`. They're replaced by the centralized element controlled by `playbackRef`.

Do the same in `SystemBlock` — delete the `audioRef`, its volume `useEffect`, and the `{isBriefing && audioUrl && <audio ref={audioRef} ...`.

- [ ] **Step 8: Simplify speaker-click handlers in `TurnBlock` and `SystemBlock`**

In `TurnBlock`, find the speaker button's `onClick` (the one wrapped with `isAudible` checks). Replace its onClick with:

```jsx
            onClick={() => {
              if (playbackRef.current?.isAudible()) {
                playbackRef.current.abortCurrent();
                return;
              }
              if (audioUrl) {
                playbackRef.current?.play(turn.id, audioUrl);
              } else {
                onPlay();
              }
            }}
```

But `playbackRef` is not in `TurnBlock`'s closure — it's at the App level. We need to pass it as a prop OR pass through callback functions.

Cleanest: pass two callbacks as props.

Find the `TurnBlock` props signature:
```typescript
function TurnBlock({ turn, audioUrl, autoPlay, volume = 1, onPlay, onStopAudio, isAudible, imageUrl, imagePending, onGenerateImage, onZoomImage }: {
```

Replace with:
```typescript
function TurnBlock({ turn, audioUrl, onPlay, onPlayCached, onAbort, isAudible, imageUrl, imagePending, onGenerateImage, onZoomImage }: {
```

Update the destructured type:
```typescript
  turn: Turn;
  audioUrl?: string;
  onPlay: () => void;         // request server-side render (no cached URL yet)
  onPlayCached?: () => void;  // play known URL via centralized element
  onAbort?: () => void;       // stop everything
  isAudible?: () => boolean;
  imageUrl?: string;
  imagePending?: boolean;
  onGenerateImage?: () => void;
  onZoomImage?: (url: string) => void;
```

Drop the `autoPlay`, `volume`, `onStopAudio` props — those are owned by the central element / controller now.

Delete the `useEffect` that auto-plays based on `autoPlay && audioUrl && audioRef.current` (the controller's `play(turnId, url)` from the WS handler does this now).

Replace the speaker button's `onClick` with:

```jsx
            onClick={() => {
              if (isAudible?.()) {
                onAbort?.();
                return;
              }
              if (audioUrl) {
                onPlayCached?.();
              } else {
                onPlay();
              }
            }}
```

Apply the same prop change + onClick replacement to `SystemBlock`.

- [ ] **Step 9: Update the App component's render to pass the new callbacks**

Find where `TurnBlock` and `SystemBlock` are rendered. Replace the existing prop passes (`onPlay`, `onStopAudio`, `isAudible`, `audioUrl`, `autoPlay`, `volume`) with the new shape:

```jsx
                <TurnBlock
                  key={t.id}
                  turn={t}
                  audioUrl={audioByTurn[t.id]}
                  onPlay={() => {
                    if (t.narrative) {
                      renderTurn(t.id, t.narrative);
                    }
                  }}
                  onPlayCached={() => {
                    if (audioByTurn[t.id]) {
                      playbackRef.current?.play(t.id, audioByTurn[t.id]);
                    }
                  }}
                  onAbort={() => playbackRef.current?.abortCurrent()}
                  isAudible={() => playbackRef.current?.isAudible() ?? false}
                  imageUrl={imageByTurn[t.id]}
                  imagePending={imagePending.has(t.id)}
                  onGenerateImage={t.narrative ? () => renderImage(t.id, t.narrative!) : undefined}
                  onZoomImage={setLightbox}
                />
```

For the SystemBlock render, apply the same prop changes.

- [ ] **Step 10: Update `renderTurn` (the auto-play helper)**

Find `renderTurn`. The current implementation uses `playbackRef.current?.renderManual(...)` (the old controller method). Replace its body to call the server-side TTS via HTTP:

Wait — there's no `/api/speak` route anymore (deleted in Task 9). The on-demand render path goes through... the sidecar directly?

Actually the cleaner answer: drop `renderTurn` entirely. The audio is generated server-side when the turn happens (via the WS `audio-ready` message). Manual speaker click on a turn without `audioUrl` shouldn't happen in normal play — only if the user disabled narration mid-turn or the sidecar errored.

For now, the `onPlay` handler in TurnBlock when audioUrl is missing should just be a no-op (or log a warning that narration is unavailable). Future enhancement: send a "regenerate audio for turn N" WS request. Out of scope here.

Update `renderTurn` to log + no-op:

```typescript
  const renderTurn = useCallback((turnId: number, _text: string) => {
    // On-demand regeneration isn't wired in this version — audio is produced
    // server-side at turn time. If audioUrl is missing, narration was off or
    // the sidecar errored. The speaker click in that case is a no-op.
    console.warn(`[narration] audio not available for turn ${turnId}; renderTurn is a no-op`);
  }, []);
```

- [ ] **Step 11: Update `toggleNarration` and `changeVoice`**

Find `toggleNarration`. Update its body to drive the new controller:

```typescript
  const toggleNarration = useCallback(async () => {
    const next = !narrationOn;
    setNarrationOn(next);
    try { localStorage.setItem("narrationOn", next ? "1" : "0"); } catch {}
    playbackRef.current?.setEnabled(next);
  }, [narrationOn]);
```

Find `changeVoice`. Simplify it:

```typescript
  const changeVoice = useCallback((voice: string) => {
    playbackRef.current?.setVoice(voice);
    setSelectedVoice(voice);
    try { localStorage.setItem("narrationVoice", voice); } catch {}
    setAudioByTurn({});  // old cached URLs were for the old voice
  }, []);
```

- [ ] **Step 12: Update the volume effect**

Find:
```typescript
  useEffect(() => {
    ttsRef.current?.setVolume(volume);
  }, [volume]);
```

Replace with:
```typescript
  useEffect(() => {
    playbackRef.current?.setVolume(volume);
  }, [volume]);
```

- [ ] **Step 13: Drop the obsolete imports and refs**

Find:
```typescript
import { TTSEngine, type EngineStatus } from "./tts";
```

Delete entirely.

Find any remaining reference to `EngineStatus`, `setEngineStatus`, `engineStatus`, `serverAudioPendingTurnIdRef`, and `lastNarratedId`. These are all obsolete.

Specifically delete:
- `const [engineStatus, setEngineStatus] = useState<EngineStatus>(...)` line and its useState import dependency
- `const serverAudioPendingTurnIdRef = useRef<number | null>(null);`
- `const [lastNarratedId, setLastNarratedId] = useState<number | null>(null);`
- Any code that READS those (e.g., `setLastNarratedId(null)`, `serverAudioPendingTurnIdRef.current = ...`)

Also delete the "auto-render narration" useEffect (the one that walked `turns` looking for un-narrated ones). The server now produces audio at turn-time and pushes the URL via `audio-ready` — no client-side auto-render needed.

- [ ] **Step 14: Update gating for the disabled-narration buttons**

The voice toggle button currently checks `providers?.useGeminiNarration` to enable itself. Update to check `providers?.useNarration && providers?.narrationReady`:

Find each `providers?.useGeminiNarration` and replace with `(providers?.useNarration && providers?.narrationReady)`. Tooltip messages similarly: replace `"USE_GEMINI_NARRATION=false in .env"` with:

```typescript
title={
  !providers?.useNarration
    ? "USE_NARRATION=false in .env"
    : !providers?.narrationReady
      ? "Narration warming up..."
      : "toggle narration"
}
```

Same shape for the voice-modal opener.

The images buttons (`useGeminiImages` checks) stay unchanged.

- [ ] **Step 15: Run full test suite**

Run: `bun test`
Expected: all tests pass.

Run: `bunx tsc --noEmit`
Expected: no new errors. Some pre-existing type errors in app.tsx may exist; verify the count is unchanged from baseline.

- [ ] **Step 16: Commit**

```bash
git add src/web/app.tsx
git commit -m "feat(web): wire <audio> element + audio-ready handler; drop TTSEngine and chunk path"
```

---

## Task 12: Delete the now-dead files

**Files:**
- Delete: `src/gemini-tts.ts`
- Delete: `src/web/tts.ts`
- Delete: `src/web/tts.test.ts`

These are no longer imported. Verify with grep before deleting.

- [ ] **Step 1: Verify nothing imports the dead files**

Run:
```bash
grep -rn "from \"./gemini-tts\"\|from \"./tts\"" src/ --include="*.ts" --include="*.tsx"
```

Expected: matches for `src/server.ts` importing `./tts` (the NEW one — correct), and nothing else.

```bash
grep -rn "from \"./tts\"\|from \"../tts\"" src/web/ --include="*.ts" --include="*.tsx"
```

Expected: no matches (web/tts.ts is no longer imported).

If grep returns unexpected matches, those need their imports updated before deleting.

- [ ] **Step 2: Delete the files**

```bash
rm src/gemini-tts.ts src/web/tts.ts src/web/tts.test.ts
```

- [ ] **Step 3: Run full suite**

Run: `bun test`
Expected: all tests pass.

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: delete obsolete gemini-tts and Web Audio scaffolding"
```

---

## Task 13: Update `.env-sample`, `README.md`, and `.gitignore`

**Files:**
- Modify: `.env-sample`
- Modify: `README.md`
- Modify: `.gitignore`

- [ ] **Step 1: Update `.env-sample`**

Find the `USE_GEMINI_NARRATION` line and replace with:

```
## Run the Python TTS sidecar at startup. Default: true.
## Set USE_NARRATION=false if you haven't installed the sidecar (no Python,
## no GPU, etc.) — the game still works, just without spoken narration.
USE_NARRATION=true
```

Also update the comment near `GEMINI_API_KEY` to note it's now images-only:

Find:
```
## Required if either USE_GEMINI_* flag below is true.
## Get a key at https://aistudio.google.com/app/api-keys
```

Replace with:
```
## Required if USE_GEMINI_IMAGES is true (narration uses self-hosted Chatterbox).
## Get a key at https://aistudio.google.com/app/api-keys
```

And delete the now-defunct `USE_GEMINI_NARRATION=false` line entirely.

- [ ] **Step 2: Update `README.md` Configuration section**

Find the line `USE_GEMINI_NARRATION=false` in the README's bash code block and replace it with:

```
USE_NARRATION=true
```

After the bash block, add a new paragraph:

```markdown
**Narration is a separate setup.** Narration uses a self-hosted Python sidecar
(ResembleAI Chatterbox Turbo). It's free but requires Python 3.11+ and ideally
an NVIDIA GPU. See `tts_sidecar/README.md` for installation. If you skip it,
set `USE_NARRATION=false` — the game runs fine without narration.
```

- [ ] **Step 3: Update `.gitignore`**

Append:
```
# Generated audio files (re-created on demand from the disk cache)
media/audio/

# Python sidecar virtualenv (if user creates one in-tree)
tts_sidecar/.venv/
tts_sidecar/__pycache__/
tts_sidecar/.pytest_cache/
```

- [ ] **Step 4: Commit**

```bash
git add .env-sample README.md .gitignore
git commit -m "docs: update env-sample + README + gitignore for Chatterbox TTS"
```

---

## Task 14: USER ACTION — install sidecar, generate voices, manual verification

**This task requires the USER to run commands the subagent cannot run. The subagent's job is to verify all prior tasks committed cleanly and then signal the user.**

- [ ] **Step 1: Sanity-check the branch state**

Run: `git log --oneline main..HEAD`
Expected: 13 commits, one per task above (excluding Task 14 itself).

Run: `bun test`
Expected: green.

- [ ] **Step 2: Report ready and hand off**

Tell the user (via the conversation, not a commit message):

> Plan tasks 1-13 are committed. The remaining work is yours to do once:
>
> 1. **Install the sidecar:**
>    ```bash
>    python -m venv tts_sidecar/.venv
>    source tts_sidecar/.venv/bin/activate
>    pip install -r tts_sidecar/requirements.txt
>    ```
>
> 2. **Generate the bundled voices** (one-time):
>    ```bash
>    python tts_sidecar/generate_voices.py
>    git add tts_sidecar/voices/*.wav
>    git commit -m "feat(tts-sidecar): bundled voice references (noir, warm, crisp)"
>    ```
>
> 3. **Run the sidecar tests** (one-time validation):
>    ```bash
>    pytest tts_sidecar/test_server.py
>    ```
>
> 4. **Manual verification matrix:**
>    Run `bun --hot src/server.ts` and verify each:
>    | Scenario | Expected |
>    |---|---|
>    | Boot, watch console | See `[tts-sidecar] ready; voices: [...]` within 15s |
>    | Voice toggle button | Greyed during warmup, clickable once ready |
>    | Submit turn, narration on | Narrative appears, then audio plays a beat later |
>    | Submit second turn while audio plays | First stops, second starts |
>    | Click speaker on completed turn | Replays instantly (disk cache hit) |
>    | Change voice mid-session | Current audio stops, next turn uses new voice |
>    | Kill Python sidecar from another terminal | Bun logs the death; narration disables for the session |
>
> 5. **If verification passes**, finishing-a-development-branch closes out the worktree + merges to main.

---

## Self-Review Notes

**Spec coverage:**
- Two-process architecture (Bun + Python) → Tasks 1-3 (Python), Task 6 (Bun-side lifecycle), Task 9 (Bun spawns sidecar at boot).
- HTTP IPC (`/health`, `POST /tts`) → Tasks 1, 3.
- Content-hash disk cache → Task 7.
- WS `audio-ready` message → Task 9.
- Frontend `<audio>` coordination via slimmed PlaybackController → Tasks 10, 11.
- Bundled voices (`noir`, `warm`, `crisp`) + `generate_voices.py` → Task 4, Task 14.
- `USE_NARRATION` flag (defaults true), drop `useGeminiNarration` → Task 8.
- Eager sidecar boot + `narrationReady` flag → Tasks 6, 9.
- 503s for warmup / disabled state → Task 9 (server.ts route) + Task 11 (frontend button gating).
- Error handling matrix (Python missing, model load fails, /tts 500) → Task 1 (initial structure), Task 6 (Bun-side graceful timeout), Task 9 (audio-error WS path).
- Tests at sidecar, Bun-tts.ts, sidecar.ts, playback-controller, server levels → Tasks 2, 6, 7, 9, 10.
- File deletes (gemini-tts, src/web/tts) → Task 12.
- README/env-sample/gitignore updates → Task 13.
- Manual user-action steps → Task 14.

**Placeholder check:** Tasks 1, 3, 7, 9, 10 all include complete code blocks for the implementations. Task 11 has step-by-step diffs for the (sizable) app.tsx changes. No "implement X here" or "handle the edge case" handwaves.

**Type consistency:**
- `narrationReady` defined in server.ts (Task 9 ProviderInfo), referenced in app.tsx (Task 11) — matches.
- `useNarration` defined in config.ts (Task 8), consumed in server.ts (Task 9 + main()) and app.tsx (Task 11 button gating).
- `audio-ready` WS message: `{type, turnId, url}` — same shape in server.ts emission (Task 9) and app.tsx handler (Task 11).
- `PlaybackController` methods: `play(turnId, url)`, `abortCurrent()`, `setVoice(v)`, `setEnabled(on)`, `setVolume(v)`, `attachElement(el)`, `isAudible()` — all referenced consistently.
- `synthesizeToFile(text, voice): Promise<string>` — Task 7 exports, Task 9 imports.

**Verification command:** `bun test && bunx tsc --noEmit` after each commit; full sidecar end-to-end at Task 14.
