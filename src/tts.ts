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
  return createHash("sha256").update(`${voice} ${text}`).digest("hex").slice(0, 16);
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
