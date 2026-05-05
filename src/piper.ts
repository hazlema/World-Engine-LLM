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
