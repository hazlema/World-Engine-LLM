/**
 * ElevenLabs cloud TTS client.
 *
 * One-shot fetch against /v1/text-to-speech/{voice_id}. Returns mp3 bytes.
 * Used by tts.ts when USE_ELEVENLABS=true; otherwise the local Chatterbox
 * sidecar handles synthesis.
 */

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";

export async function synthesizeElevenLabs(
  text: string,
  voiceId: string,
  apiKey: string,
  model: string,
): Promise<Uint8Array> {
  const res = await fetch(`${ELEVENLABS_BASE}/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: model,
      output_format: "mp3_44100_128",
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`elevenlabs ${res.status}: ${detail.slice(0, 200)}`);
  }

  return new Uint8Array(await res.arrayBuffer());
}
