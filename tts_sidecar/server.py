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
