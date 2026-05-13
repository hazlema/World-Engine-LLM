import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("synthesizeToFile", () => {
  let tmpRoot: string;
  let origMediaRoot: string | undefined;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "tts-test-"));
    origMediaRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = tmpRoot;
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origMediaRoot === undefined) {
      delete process.env.MEDIA_ROOT;
    } else {
      process.env.MEDIA_ROOT = origMediaRoot;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("first call: posts to sidecar, writes file, returns URL path", async () => {
    let postCalls = 0;
    (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
      postCalls++;
      if (init?.method === "POST") {
        return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x02]), {
          status: 200,
          headers: { "content-type": "audio/wav" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const { synthesizeToFile } = await import("./tts");
    const url = await synthesizeToFile("hello world", "noir");

    expect(url).toMatch(/^\/media\/audio\/[0-9a-f]{16}\.wav$/);
    const filePath = join(tmpRoot, "audio", url.replace("/media/audio/", ""));
    expect(existsSync(filePath)).toBe(true);
    expect(postCalls).toBe(1);
  });

  test("second call with same text+voice: skips sidecar, returns same URL", async () => {
    let postCalls = 0;
    (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        postCalls++;
        return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
          status: 200,
          headers: { "content-type": "audio/wav" },
        });
      }
      throw new Error("unexpected GET");
    };

    const { synthesizeToFile } = await import("./tts");
    const url1 = await synthesizeToFile("hello world", "noir");
    const url2 = await synthesizeToFile("hello world", "noir");

    expect(url1).toBe(url2);
    expect(postCalls).toBe(1);
  });

  test("different voice = different hash = different file", async () => {
    (globalThis as any).fetch = async () =>
      new Response(new Uint8Array([0x52]), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });

    const { synthesizeToFile } = await import("./tts");
    const url1 = await synthesizeToFile("hello", "noir");
    const url2 = await synthesizeToFile("hello", "warm");

    expect(url1).not.toBe(url2);
  });

  test("different text = different hash = different file", async () => {
    (globalThis as any).fetch = async () =>
      new Response(new Uint8Array([0x52]), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });

    const { synthesizeToFile } = await import("./tts");
    const url1 = await synthesizeToFile("hello", "noir");
    const url2 = await synthesizeToFile("goodbye", "noir");

    expect(url1).not.toBe(url2);
  });

  test("sidecar 500: throws with the error detail", async () => {
    (globalThis as any).fetch = async () =>
      new Response("model crashed", { status: 500 });

    const { synthesizeToFile } = await import("./tts");
    await expect(synthesizeToFile("hello", "noir")).rejects.toThrow(/500/);
  });

  test("pre-existing cached file: skips sidecar entirely", async () => {
    // Pre-seed the cache so the first call is a hit.
    const { _hashForTesting } = await import("./tts");
    const hash = _hashForTesting("hello world", "noir");
    const audioDir = join(tmpRoot, "audio");
    require("node:fs").mkdirSync(audioDir, { recursive: true });
    writeFileSync(join(audioDir, `${hash}.wav`), new Uint8Array([0xab]));

    let postCalls = 0;
    (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") postCalls++;
      return new Response(new Uint8Array([0]), { status: 200 });
    };

    const { synthesizeToFile } = await import("./tts");
    const url = await synthesizeToFile("hello world", "noir");
    expect(url).toBe(`/media/audio/${hash}.wav`);
    expect(postCalls).toBe(0);
  });
});
