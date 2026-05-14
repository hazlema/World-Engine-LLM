/**
 * Lifecycle for the Python TTS sidecar process.
 *
 * - spawnSidecar() launches `python3 tts_sidecar/server.py` as a Bun child.
 * - waitForSidecarReady() polls /health until ready:true or timeout.
 * - markSidecarReady() flips an internal flag (also called by waitForSidecarReady).
 * - isNarrationReady() exposes the flag to the rest of the server.
 * - SIGINT/SIGTERM on the Bun process kill the Python child cleanly.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

const SIDECAR_HOST = process.env.TTS_SIDECAR_HOST ?? "127.0.0.1";
const SIDECAR_PORT = process.env.TTS_SIDECAR_PORT ?? "5005";
export const SIDECAR_BASE_URL = `http://${SIDECAR_HOST}:${SIDECAR_PORT}`;

/**
 * Resolve the Python interpreter to use for the sidecar.
 *
 * Prefers `tts_sidecar/.venv/bin/python` if the in-tree venv exists
 * (matches the setup recommended in tts_sidecar/README.md). Falls back
 * to `python3` from PATH otherwise. Override with TTS_SIDECAR_PYTHON env
 * var if neither path is correct on your system.
 */
function pythonExecutable(): string {
  const override = process.env.TTS_SIDECAR_PYTHON;
  if (override) return override;
  const venvPython = join(process.cwd(), "tts_sidecar", ".venv", "bin", "python");
  if (existsSync(venvPython)) return venvPython;
  return "python3";
}

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

  const py = pythonExecutable();
  console.log(`[tts] using python: ${py}`);
  const proc = Bun.spawn([py, "tts_sidecar/server.py"], {
    env: { ...process.env, TTS_SIDECAR_HOST: SIDECAR_HOST, TTS_SIDECAR_PORT: SIDECAR_PORT },
    stdout: "pipe",
    stderr: "pipe",
  });

  _process = proc;
  pipeWithPrefix(proc.stdout, "[tts-sidecar]");
  pipeWithPrefix(proc.stderr, "[tts-sidecar]");

  // Make sure the child dies when Bun dies. Installing a SIGINT/SIGTERM
  // handler overrides Node/Bun's default of terminating the process, so we
  // have to exit explicitly after killing the child — otherwise Ctrl-C only
  // kills the sidecar and Bun keeps running.
  const killChild = () => {
    if (_process && _process.exitCode === null) {
      _process.kill("SIGTERM");
    }
  };
  process.on("SIGINT", () => { killChild(); process.exit(0); });
  process.on("SIGTERM", () => { killChild(); process.exit(0); });
  process.on("exit", killChild);

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
