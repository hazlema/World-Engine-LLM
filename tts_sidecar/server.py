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

# Module-level state. The model loads asynchronously on startup.
_model = None
_ready = False
_load_error: Optional[str] = None


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


def _gen_float(name: str, default: float) -> float:
    """Read a float from env, return default if unset or unparseable."""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _gen_int(name: str, default: int) -> int:
    """Read an int from env, return default if unset or unparseable."""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def generate_audio(text: str, voice: str) -> bytes:
    """Generate WAV bytes via Chatterbox Turbo using the named voice reference.

    Turbo's generate() ignores cfg_weight/exaggeration/min_p (those apply to
    original Chatterbox only). The knobs that DO affect Turbo output:

      - repetition_penalty (default 1.2; raise to 1.5-2.0 to discourage
        repeating words / nonsense loops)
      - temperature (default 0.8; lower to 0.6 for more deterministic prose)
      - top_p (default 0.95)
      - top_k (default 1000)

    All four are tunable via env vars at sidecar start time, without code
    changes. Restart Bun for changes to take effect.
    """
    if _model is None:
        raise RuntimeError(
            f"model not loaded yet "
            f"(load_error={_load_error!r}, ready={_ready})"
        )

    voice_path = VOICES_DIR / f"{voice}.wav"
    if not voice_path.exists():
        raise RuntimeError(f"voice reference file missing: {voice_path}")

    # Chatterbox's first few output tokens can be garbled while the prosody
    # system warms up. Prepending a short throwaway phrase lets the model
    # absorb that warmup on something the listener won't miss. Defaults
    # empty (off) — set TTS_TEXT_PREFIX=". " for a near-invisible pause, or
    # "Ah, " for a softer human-sounding warmup.
    prefix = os.environ.get("TTS_TEXT_PREFIX", "")
    payload = f"{prefix}{text}" if prefix else text

    # Chatterbox returns a torch tensor; convert to a WAV byte buffer.
    import torchaudio as ta

    wav_tensor = _model.generate(
        payload,
        audio_prompt_path=str(voice_path),
        repetition_penalty=_gen_float("TTS_REPETITION_PENALTY", 1.2),
        temperature=_gen_float("TTS_TEMPERATURE", 0.8),
        top_p=_gen_float("TTS_TOP_P", 0.95),
        top_k=_gen_int("TTS_TOP_K", 1000),
    )
    buf = io.BytesIO()
    ta.save(buf, wav_tensor, _model.sr, format="wav")
    return buf.getvalue()


app = FastAPI(title="Chatterbox TTS sidecar")


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

    # TTS_SIDECAR_DEVICE overrides auto-detect (e.g., force CPU when GPU is
    # too crowded to hold Chatterbox alongside LM Studio).
    override = os.environ.get("TTS_SIDECAR_DEVICE", "").strip().lower()
    if override in ("cuda", "cpu"):
        device = override
    else:
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


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"ready": _ready, "voices": list_voices()})


@app.post("/tts")
async def tts(request: Request, voice: str = Query(...)) -> Response:
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

    body = await request.body()
    text = body.decode("utf-8").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text body is required")

    try:
        if voice == "mock" and _model is None:
            wav_bytes = make_silent_wav(1.0)
        else:
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
