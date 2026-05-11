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

export type RenderResult = { url: string; durationMs: number };
export type StreamEndResult = { turnId: number; url: string };

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

  // Streaming state for server-pushed PCM chunks.
  private streamingTurnId: number | null = null;
  private streamingChunks: Uint8Array[] = [];
  private nextStartTime = 0;

  constructor(private onStatus: (s: EngineStatus) => void) {}

  private setStatus(s: EngineStatus) {
    this.status = s;
    this.onStatus(s);
  }

  private stopActiveSources() {
    for (const src of this.activeSources) {
      try { src.stop(0); } catch { /* already stopped */ }
    }
    this.activeSources = [];
  }

  // Stop both Web Audio streaming sources AND any <audio> element playback.
  // Call before starting any new audio so streams and replays never overlap.
  stopAll() {
    this.stopActiveSources();
    if (typeof document !== "undefined") {
      document.querySelectorAll("audio").forEach((a) => (a as HTMLAudioElement).pause());
    }
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
    if (ctx.state !== "running") {
      this.audioCtx = null;
      this.gainNode = null;
      this.setStatus({ kind: "error", message: "AudioContext blocked — needs user gesture" });
      return;
    }
    this.setStatus({ kind: "ready" });
  }

  // --- Streaming path (server pushes PCM chunks via WebSocket) ---

  startStream(turnId: number) {
    const ctx = this.audioCtx;
    if (!ctx) return;
    this.stopAll();
    this.streamingTurnId = turnId;
    this.streamingChunks = [];
    this.nextStartTime = ctx.currentTime + 0.05;
  }

  addChunk(pcm: Uint8Array) {
    const ctx = this.audioCtx;
    if (!ctx || this.streamingTurnId === null || pcm.byteLength === 0) return;
    this.streamingChunks.push(pcm);

    const sampleCount = pcm.byteLength >> 1;
    if (sampleCount === 0) return;

    const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const floats = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      floats[i] = dv.getInt16(i * 2, true) / 32768;
    }

    const audioBuf = ctx.createBuffer(1, sampleCount, PCM_SAMPLE_RATE);
    audioBuf.copyToChannel(floats, 0);

    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(this.gainNode ?? ctx.destination);

    const startAt = Math.max(this.nextStartTime, ctx.currentTime + 0.001);
    src.start(startAt);
    this.nextStartTime = startAt + audioBuf.duration;
    this.activeSources.push(src);
  }

  endStream(): StreamEndResult | null {
    const turnId = this.streamingTurnId;
    if (turnId === null) return null;

    const totalLen = this.streamingChunks.reduce((n, c) => n + c.length, 0);
    this.streamingTurnId = null;
    const chunks = this.streamingChunks;
    this.streamingChunks = [];
    if (totalLen === 0) return null;

    const pcm = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.length; }
    const url = URL.createObjectURL(new Blob([pcmToWav(pcm)], { type: "audio/wav" }));
    this.cache.set(turnId, url);
    return { turnId, url };
  }

  // --- HTTP-streaming path (system briefings, manual replay before audio is cached) ---

  render(turnId: number, text: string, voice?: string): Promise<RenderResult> {
    return this.queue.enqueue(async () => {
      const cached = this.cache.get(turnId);
      if (cached) return { url: cached, durationMs: 0 };

      if (!this.audioCtx) await this.load();
      if (!this.audioCtx) throw new Error("TTSEngine not loaded");

      const t0 = performance.now();
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const message = `speak failed: ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
        this.setStatus({ kind: "error", message });
        throw new Error(message);
      }

      this.startStream(turnId);
      const reader = res.body!.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // If a newer stream took ownership (e.g. WS audio-start for a new turn),
        // drop these chunks on the floor. Keep draining the response so the
        // fetch closes cleanly, but don't schedule them on AudioContext or
        // push them into the new stream's chunk buffer.
        if (this.streamingTurnId !== turnId) continue;
        if (value && value.byteLength > 0) this.addChunk(value);
      }
      const dur = performance.now() - t0;
      if (this.streamingTurnId !== turnId) {
        throw new Error(`render turn ${turnId} preempted by newer stream`);
      }
      const result = this.endStream();
      console.info(`[tts] render turn ${turnId}: ${text.length} chars in ${Math.round(dur)}ms (${voice ?? "default"})`);
      if (!result) throw new Error("speak returned no audio");
      return { url: result.url, durationMs: dur };
    });
  }
}
