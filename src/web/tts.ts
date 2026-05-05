import { KokoroTTS } from "kokoro-js";

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

export const DEFAULT_VOICE = "af_heart";
export const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

export type EngineStatus =
  | { kind: "idle" }
  | { kind: "loading"; progress: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export type RenderResult = { url: string; durationMs: number };

export class TTSEngine {
  private model: KokoroTTS | null = null;
  private loadPromise: Promise<void> | null = null;
  private queue = new RenderQueue();
  cache = new AudioCache();
  status: EngineStatus = { kind: "idle" };

  constructor(private onStatus: (s: EngineStatus) => void) {}

  private setStatus(s: EngineStatus) {
    this.status = s;
    this.onStatus(s);
  }

  async load(): Promise<void> {
    if (this.model) return;
    if (this.loadPromise) return this.loadPromise;
    this.setStatus({ kind: "loading", progress: 0 });
    this.loadPromise = (async () => {
      try {
        this.model = await KokoroTTS.from_pretrained(MODEL_ID, {
          dtype: "q8",
          device: "wasm",
          progress_callback: (p: { progress?: number }) => {
            if (typeof p.progress === "number") {
              this.setStatus({ kind: "loading", progress: p.progress });
            }
          },
        });
        this.setStatus({ kind: "ready" });
      } catch (err) {
        this.setStatus({ kind: "error", message: (err as Error).message });
        throw err;
      }
    })();
    return this.loadPromise;
  }

  render(turnId: number, text: string, voice: string = DEFAULT_VOICE): Promise<RenderResult> {
    return this.queue.enqueue(async () => {
      const cached = this.cache.get(turnId);
      if (cached) return { url: cached, durationMs: 0 };
      await this.load();
      if (!this.model) throw new Error("model not loaded");
      const t0 = performance.now();
      const audio = await this.model.generate(text, { voice });
      const blob = audio.toBlob();
      const url = URL.createObjectURL(blob);
      this.cache.set(turnId, url);
      return { url, durationMs: performance.now() - t0 };
    });
  }
}
