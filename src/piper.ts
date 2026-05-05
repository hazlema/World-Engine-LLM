import { mkdir, chmod } from "node:fs/promises";
import { $ } from "bun";

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
