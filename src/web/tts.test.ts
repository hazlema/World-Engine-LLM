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
