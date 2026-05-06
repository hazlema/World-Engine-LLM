import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piperPaths, isPiperReady, streamDownload } from "./piper";

describe("piperPaths", () => {
  test("derives all four paths under the given root", () => {
    const p = piperPaths("/some/root");
    expect(p.binDir).toBe("/some/root");
    expect(p.binary).toBe("/some/root/piper/piper");
    expect(p.voiceModel).toBe("/some/root/voices/en_US-lessac-medium.onnx");
    expect(p.voiceConfig).toBe("/some/root/voices/en_US-lessac-medium.onnx.json");
  });
});

describe("isPiperReady", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "piper-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns false when binary is missing", async () => {
    expect(await isPiperReady(dir)).toBe(false);
  });

  test("returns false when binary exists but voice files don't", async () => {
    mkdirSync(join(dir, "piper"), { recursive: true });
    writeFileSync(join(dir, "piper/piper"), "");
    expect(await isPiperReady(dir)).toBe(false);
  });

  test("returns true when binary, model, and config all exist", async () => {
    mkdirSync(join(dir, "piper"), { recursive: true });
    mkdirSync(join(dir, "voices"), { recursive: true });
    writeFileSync(join(dir, "piper/piper"), "");
    writeFileSync(join(dir, "voices/en_US-lessac-medium.onnx"), "");
    writeFileSync(join(dir, "voices/en_US-lessac-medium.onnx.json"), "{}");
    expect(await isPiperReady(dir)).toBe(true);
  });
});

describe("streamDownload", () => {
  let dir: string;
  let fetchSpy: any;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "stream-test-")); });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    fetchSpy?.mockRestore();
  });

  function mockResponse(chunks: Uint8Array[], totalHeader?: number): Response {
    const stream = new ReadableStream({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    const headers: Record<string, string> = {};
    if (totalHeader !== undefined) headers["content-length"] = String(totalHeader);
    return new Response(stream, { status: 200, headers });
  }

  test("streams bytes to disk and reports progress", async () => {
    const payload = new Uint8Array(100).fill(7);
    const dest = join(dir, "out.bin");
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse([payload.slice(0, 50), payload.slice(50)], 100)
    );
    const logSpy = spyOn(console, "log");
    await streamDownload("https://example.test/x", dest, "test");
    expect(readFileSync(dest)).toEqual(Buffer.from(payload));
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  test("throws when received bytes don't match Content-Length", async () => {
    const dest = join(dir, "short.bin");
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse([new Uint8Array(10)], 100)
    );
    await expect(streamDownload("https://example.test/x", dest, "short")).rejects.toThrow("truncated");
  });

  test("throws on non-OK response without writing", async () => {
    const dest = join(dir, "fail.bin");
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("nope", { status: 404, statusText: "Not Found" })
    );
    await expect(streamDownload("https://example.test/x", dest, "fail")).rejects.toThrow("404");
  });
});
