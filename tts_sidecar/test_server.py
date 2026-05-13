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
