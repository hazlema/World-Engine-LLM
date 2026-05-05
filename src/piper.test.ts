import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piperPaths, isPiperReady } from "./piper";

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
