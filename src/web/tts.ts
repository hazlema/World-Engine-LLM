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

export class TTSEngine {
  private queue = new RenderQueue();
  cache = new AudioCache();
  status: EngineStatus = { kind: "idle" };

  constructor(private onStatus: (s: EngineStatus) => void) {}

  private setStatus(s: EngineStatus) {
    this.status = s;
    this.onStatus(s);
  }

  // No model to load — engine is "ready" the moment the toggle flips on.
  // Kept as an async method so the existing call-site (`await ttsRef.current?.load()`)
  // doesn't need to change.
  async load(): Promise<void> {
    if (this.status.kind === "ready") return;
    this.setStatus({ kind: "ready" });
  }

  render(turnId: number, text: string): Promise<RenderResult> {
    return this.queue.enqueue(async () => {
      const cached = this.cache.get(turnId);
      if (cached) return { url: cached, durationMs: 0 };
      const t0 = performance.now();
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const message = `speak failed: ${res.status}`;
        this.setStatus({ kind: "error", message });
        throw new Error(message);
      }
      const blob = await res.blob();
      const dur = performance.now() - t0;
      console.info(`[tts] render turn ${turnId}: ${text.length} chars in ${Math.round(dur)}ms`);
      const url = URL.createObjectURL(blob);
      this.cache.set(turnId, url);
      return { url, durationMs: dur };
    });
  }
}
