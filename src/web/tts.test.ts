import { test, expect, describe } from "bun:test";
import { AudioCache, RenderQueue } from "./tts";

describe("AudioCache", () => {
  test("get returns null for missing keys", () => {
    const c = new AudioCache();
    expect(c.get(1)).toBeNull();
  });

  test("set then get returns the same blob URL", () => {
    const c = new AudioCache();
    c.set(1, "blob:abc");
    expect(c.get(1)).toBe("blob:abc");
  });

  test("evicts oldest when over capacity", () => {
    const c = new AudioCache(2);
    c.set(1, "blob:a");
    c.set(2, "blob:b");
    c.set(3, "blob:c");
    expect(c.get(1)).toBeNull();
    expect(c.get(2)).toBe("blob:b");
    expect(c.get(3)).toBe("blob:c");
  });

  test("clear removes all entries", () => {
    const c = new AudioCache();
    c.set(1, "blob:a");
    c.clear();
    expect(c.get(1)).toBeNull();
  });

  test("re-setting the same id replaces the value without evicting others", () => {
    const c = new AudioCache(2);
    c.set(1, "blob:a");
    c.set(2, "blob:b");
    c.set(1, "blob:a-new");
    expect(c.get(1)).toBe("blob:a-new");
    expect(c.get(2)).toBe("blob:b");
  });

  test("re-setting the same id revokes the prior URL", () => {
    const revoked: string[] = [];
    const original = URL.revokeObjectURL;
    (URL as any).revokeObjectURL = (url: string) => revoked.push(url);
    try {
      const c = new AudioCache();
      c.set(1, "blob:a");
      c.set(1, "blob:b");
      expect(revoked).toContain("blob:a");
    } finally {
      (URL as any).revokeObjectURL = original;
    }
  });
});

describe("RenderQueue", () => {
  test("runs jobs sequentially in submission order", async () => {
    const order: number[] = [];
    const q = new RenderQueue();
    const a = q.enqueue(async () => { await Promise.resolve(); order.push(1); return 1; });
    const b = q.enqueue(async () => { await Promise.resolve(); order.push(2); return 2; });
    expect(await a).toBe(1);
    expect(await b).toBe(2);
    expect(order).toEqual([1, 2]);
  });

  test("a rejected job does not block subsequent jobs", async () => {
    const q = new RenderQueue();
    const failing = q.enqueue(async () => { throw new Error("boom"); });
    const ok = q.enqueue(async () => 42);
    await expect(failing).rejects.toThrow("boom");
    expect(await ok).toBe(42);
  });
});

describe("TTSEngine.stopAll", () => {
  test("pauses all <audio> elements in the document", () => {
    const paused: HTMLAudioElement[] = [];
    const fakeAudio = (): HTMLAudioElement => ({
      pause: function () { paused.push(this as HTMLAudioElement); },
    } as unknown as HTMLAudioElement);
    const a1 = fakeAudio();
    const a2 = fakeAudio();
    const origDoc = (globalThis as any).document;
    (globalThis as any).document = {
      querySelectorAll: (_sel: string) => [a1, a2],
    };
    try {
      const { TTSEngine } = require("./tts");
      const eng = new TTSEngine(() => {});
      eng.stopAll();
      expect(paused.length).toBe(2);
    } finally {
      (globalThis as any).document = origDoc;
    }
  });
});

describe("TTSEngine.render abort", () => {
  test("render(text, voice, signal) rejects with AbortError when signal aborts mid-stream", async () => {
    const origFetch = globalThis.fetch;
    const origAudioContext = (globalThis as any).AudioContext;

    // Fake an AudioContext that "loads" successfully.
    (globalThis as any).AudioContext = class {
      sampleRate = 24000;
      currentTime = 0;
      state = "running";
      destination = {};
      async resume() {}
      createGain() { return { gain: { value: 1 }, connect() {} }; }
      createBuffer() { return { copyToChannel() {}, duration: 0.1 }; }
      createBufferSource() {
        return { buffer: null, connect() {}, start() {}, stop() {} };
      }
    };

    // Fetch returns a stream that never completes until aborted.
    let cancelled = false;
    (globalThis as any).fetch = (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // Emit one chunk immediately, then hang.
          controller.enqueue(new Uint8Array([0, 0]));
          if (signal) {
            signal.addEventListener("abort", () => {
              cancelled = true;
              controller.error(new DOMException("aborted", "AbortError"));
            });
          }
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    };

    try {
      const { TTSEngine } = require("./tts");
      const eng = new TTSEngine(() => {});
      const ac = new AbortController();
      const p = eng.render(1, "hello", undefined, ac.signal);
      // Let the stream get going, then abort.
      await new Promise((r) => setTimeout(r, 10));
      ac.abort();
      await expect(p).rejects.toThrow();
      expect(cancelled).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
      (globalThis as any).AudioContext = origAudioContext;
    }
  });
});

describe("TTSEngine.cancelStream", () => {
  test("clears streaming state without producing a cached blob", () => {
    const origAudioContext = (globalThis as any).AudioContext;
    (globalThis as any).AudioContext = class {
      sampleRate = 24000; currentTime = 0; state = "running"; destination = {};
      async resume() {}
      createGain() { return { gain: { value: 1 }, connect() {} }; }
      createBuffer() { return { copyToChannel() {}, duration: 0.1 }; }
      createBufferSource() { return { buffer: null, connect() {}, start() {}, stop() {} }; }
    };
    try {
      const { TTSEngine } = require("./tts");
      const eng = new TTSEngine(() => {});
      return (async () => {
        await eng.load();
        eng.startStream(42);
        eng.addChunk(new Uint8Array([1, 2, 3, 4]));
        eng.cancelStream();
        // endStream should now report null since cancelStream wiped state.
        expect(eng.endStream()).toBeNull();
        expect(eng.cache.get(42)).toBeNull();
      })();
    } finally {
      (globalThis as any).AudioContext = origAudioContext;
    }
  });
});

describe("TTSEngine.addChunk frame alignment", () => {
  test("preserves bytes across odd-boundary chunk splits (no crackle)", async () => {
    const samplesWritten: Float32Array[] = [];
    const origAudioContext = (globalThis as any).AudioContext;
    (globalThis as any).AudioContext = class {
      sampleRate = 24000; currentTime = 0; state = "running"; destination = {};
      async resume() {}
      createGain() { return { gain: { value: 1 }, connect() {} }; }
      createBuffer(_channels: number, length: number) {
        return {
          length,
          duration: length / 24000,
          copyToChannel(data: Float32Array) { samplesWritten.push(data.slice()); },
        };
      }
      createBufferSource() {
        return { buffer: null, connect() {}, start() {}, stop() {} };
      }
    };

    try {
      const { TTSEngine } = require("./tts");
      const eng = new TTSEngine(() => {});
      await eng.load();
      eng.startStream(1);

      // Chunk 1: 3 bytes [0x01, 0x02, 0x03]
      //   Sample 1 LSB=0x01 MSB=0x02 → Int16 LE = 0x0201 = 513
      //   Byte 0x03 is the LSB of a half-sample, must be buffered.
      eng.addChunk(new Uint8Array([0x01, 0x02, 0x03]));

      // Chunk 2: 3 bytes [0x04, 0x05, 0x06]
      //   Combined with leftover [0x03] → [0x03, 0x04, 0x05, 0x06] (4 bytes)
      //   Sample 2 = Int16 LE of [0x03, 0x04] = 0x0403 = 1027
      //   Sample 3 = Int16 LE of [0x05, 0x06] = 0x0605 = 1541
      eng.addChunk(new Uint8Array([0x04, 0x05, 0x06]));

      // Total samples produced: 3.
      const totalSamples = samplesWritten.reduce((n, s) => n + s.length, 0);
      expect(totalSamples).toBe(3);

      // First call wrote 1 sample (513), second wrote 2 samples (1027, 1541).
      expect(samplesWritten[0].length).toBe(1);
      expect(samplesWritten[1].length).toBe(2);
      expect(samplesWritten[0][0]).toBeCloseTo(513 / 32768, 4);
      expect(samplesWritten[1][0]).toBeCloseTo(1027 / 32768, 4);
      expect(samplesWritten[1][1]).toBeCloseTo(1541 / 32768, 4);
    } finally {
      (globalThis as any).AudioContext = origAudioContext;
    }
  });

  test("clears odd-byte leftover when startStream is called for a new turn", async () => {
    const samplesWritten: Float32Array[] = [];
    const origAudioContext = (globalThis as any).AudioContext;
    (globalThis as any).AudioContext = class {
      sampleRate = 24000; currentTime = 0; state = "running"; destination = {};
      async resume() {}
      createGain() { return { gain: { value: 1 }, connect() {} }; }
      createBuffer(_channels: number, length: number) {
        return {
          length,
          duration: length / 24000,
          copyToChannel(data: Float32Array) { samplesWritten.push(data.slice()); },
        };
      }
      createBufferSource() {
        return { buffer: null, connect() {}, start() {}, stop() {} };
      }
    };

    try {
      const { TTSEngine } = require("./tts");
      const eng = new TTSEngine(() => {});
      await eng.load();

      // Stream 1: end with odd-byte leftover (orphan).
      eng.startStream(1);
      eng.addChunk(new Uint8Array([0xFF])); // 1 byte, becomes leftover.
      // Don't call endStream — simulate the stream being abandoned.

      // Stream 2: fresh stream. The 0xFF leftover must NOT leak in.
      eng.startStream(2);
      eng.addChunk(new Uint8Array([0x10, 0x20])); // 1 clean sample.

      // Only the second stream's sample should appear.
      const totalSamples = samplesWritten.reduce((n, s) => n + s.length, 0);
      expect(totalSamples).toBe(1);
      const expected = 0x2010 / 32768; // little-endian: 0x10 is LSB, 0x20 is MSB
      expect(samplesWritten[0][0]).toBeCloseTo(expected, 4);
    } finally {
      (globalThis as any).AudioContext = origAudioContext;
    }
  });
});
