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
