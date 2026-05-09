const PCM_SAMPLE_RATE = 24000;

export class AudioCache {
  private map = new Map<number, string>();
  constructor(private capacity = 32) {}

  get(id: number): string | null {
    return this.map.get(id) ?? null;
  }

  set(id: number, url: string): void {
    const prev = this.map.get(id);
    if (prev) {
      URL.revokeObjectURL(prev);
      this.map.delete(id);
    }
    if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        const stale = this.map.get(oldest);
        if (stale) URL.revokeObjectURL(stale);
        this.map.delete(oldest);
      }
    }
    this.map.set(id, url);
  }

  clear(): void {
    for (const url of this.map.values()) URL.revokeObjectURL(url);
    this.map.clear();
  }
}

export class RenderQueue {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export type EngineStatus =
  | { kind: "idle" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export type RenderResult = { url: string; durationMs: number; alreadyPlayed?: boolean };

function pcmToWav(pcm: Uint8Array): Uint8Array {
  const dataSize = pcm.length;
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + dataSize, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, PCM_SAMPLE_RATE, true);
  v.setUint32(28, PCM_SAMPLE_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, dataSize, true);
  const out = new Uint8Array(44 + dataSize);
  out.set(new Uint8Array(header));
  out.set(pcm, 44);
  return out;
}

export class TTSEngine {
  private queue = new RenderQueue();
  cache = new AudioCache();
  status: EngineStatus = { kind: "idle" };
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private activeSources: AudioBufferSourceNode[] = [];

  constructor(private onStatus: (s: EngineStatus) => void) {}

  private setStatus(s: EngineStatus) {
    this.status = s;
    this.onStatus(s);
  }

  private stopCurrent() {
    for (const src of this.activeSources) {
      try { src.stop(0); } catch { /* already stopped */ }
    }
    this.activeSources = [];
  }

  setVolume(v: number) {
    if (this.gainNode) this.gainNode.gain.value = v;
  }

  async load(): Promise<void> {
    if (this.status.kind === "ready") return;
    const ctx = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
    this.audioCtx = ctx;
    this.gainNode = ctx.createGain();
    this.gainNode.connect(ctx.destination);
    await ctx.resume();
    this.setStatus({ kind: "ready" });
  }

  render(turnId: number, text: string, voice?: string): Promise<RenderResult> {
    return this.queue.enqueue(async () => {
      const cached = this.cache.get(turnId);
      if (cached) return { url: cached, durationMs: 0 };

      this.stopCurrent();

      const ctx = this.audioCtx;
      if (!ctx) throw new Error("TTSEngine not loaded — call load() first");
      if (ctx.state === "suspended") await ctx.resume();

      const t0 = performance.now();
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice }),
      });

      if (!res.ok) {
        const message = `speak failed: ${res.status}`;
        this.setStatus({ kind: "error", message });
        throw new Error(message);
      }

      // Schedule first chunk 50 ms out so the audio graph has time to start.
      let nextStart = ctx.currentTime + 0.05;
      const allChunks: Uint8Array[] = [];
      const reader = res.body!.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.length) continue;

        allChunks.push(value);

        const sampleCount = value.byteLength >> 1;
        if (sampleCount === 0) continue;

        // Decode 16-bit signed little-endian PCM → Float32
        const dv = new DataView(value.buffer, value.byteOffset, value.byteLength);
        const floats = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
          floats[i] = dv.getInt16(i * 2, true) / 32768;
        }

        const audioBuf = ctx.createBuffer(1, sampleCount, PCM_SAMPLE_RATE);
        audioBuf.copyToChannel(floats, 0);

        const src = ctx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(this.gainNode ?? ctx.destination);

        // Clamp to "now" if the scheduler has fallen behind (large gap between chunks)
        const startAt = Math.max(nextStart, ctx.currentTime + 0.001);
        src.start(startAt);
        nextStart = startAt + audioBuf.duration;
        this.activeSources.push(src);
      }

      const dur = performance.now() - t0;
      console.info(`[tts] render turn ${turnId}: ${text.length} chars in ${Math.round(dur)}ms (${voice ?? "default"})`);

      // Stitch all PCM chunks → WAV blob for replay cache
      const totalLen = allChunks.reduce((n, c) => n + c.length, 0);
      const pcm = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of allChunks) { pcm.set(chunk, offset); offset += chunk.length; }
      const url = URL.createObjectURL(new Blob([pcmToWav(pcm)], { type: "audio/wav" }));
      this.cache.set(turnId, url);

      // Signal that Web Audio already played this turn — don't re-trigger <audio> autoplay
      return { url, durationMs: dur, alreadyPlayed: true };
    });
  }
}
