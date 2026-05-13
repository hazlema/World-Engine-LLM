import { test, expect, describe, beforeEach } from "bun:test";
import { PlaybackController, type ControllerState } from "./playback-controller";

// Minimal TTS shim — only the methods the controller calls.
function makeShim() {
  const calls: string[] = [];
  let lastSignal: AbortSignal | undefined;
  return {
    calls,
    get lastSignal() { return lastSignal; },
    stopAll: () => calls.push("stopAll"),
    cancelStream: () => calls.push("cancelStream"),
    startStream: (id: number) => calls.push(`startStream:${id}`),
    addChunk: (_b: Uint8Array) => calls.push("addChunk"),
    endStream: () => { calls.push("endStream"); return { turnId: 1, url: "blob:end" }; },
    render: async (id: number, _text: string, _v?: string, signal?: AbortSignal) => {
      lastSignal = signal;
      calls.push(`render:${id}`);
      return { url: `blob:${id}`, durationMs: 1 };
    },
    cache: { clear: () => calls.push("cache.clear"), get: (_id: number) => null },
  };
}

describe("PlaybackController", () => {
  test("starts idle with no currentTurnId", () => {
    const c = new PlaybackController(makeShim() as any);
    expect(c.state).toBe("idle");
    expect(c.currentTurnId).toBeNull();
  });

  test("beginStream(turnId) transitions to streaming and sets currentTurnId", () => {
    const shim = makeShim();
    const c = new PlaybackController(shim as any);
    c.beginStream(5);
    expect(c.state).toBe("streaming");
    expect(c.currentTurnId).toBe(5);
    expect(shim.calls).toContain("startStream:5");
  });

  test("beginStream(newId) when streaming aborts prior stream", () => {
    const shim = makeShim();
    const c = new PlaybackController(shim as any);
    c.beginStream(1);
    c.beginStream(2);
    expect(shim.calls).toContain("cancelStream");
    expect(c.currentTurnId).toBe(2);
  });

  test("addChunk only forwards when streaming and turnId matches", () => {
    const shim = makeShim();
    const c = new PlaybackController(shim as any);
    c.addChunk(new Uint8Array([1])); // idle, dropped
    c.beginStream(7);
    c.addChunk(new Uint8Array([1])); // forwarded
    expect(shim.calls.filter((x) => x === "addChunk").length).toBe(1);
  });

  test("endStream transitions back to idle and clears currentTurnId", () => {
    const c = new PlaybackController(makeShim() as any);
    c.beginStream(3);
    const result = c.endStream();
    expect(result).not.toBeNull();
    expect(c.state).toBe("idle");
    expect(c.currentTurnId).toBeNull();
  });

  test("abortCurrent from streaming calls cancelStream and goes idle", () => {
    const shim = makeShim();
    const c = new PlaybackController(shim as any);
    c.beginStream(9);
    c.abortCurrent();
    expect(shim.calls).toContain("cancelStream");
    expect(c.state).toBe("idle");
    expect(c.currentTurnId).toBeNull();
  });

  test("renderManual aborts prior, then renders with a fresh signal", async () => {
    const shim = makeShim();
    const c = new PlaybackController(shim as any);
    c.beginStream(1);
    const p = c.renderManual(2, "hello", "Kore");
    expect(shim.calls).toContain("cancelStream");
    const result = await p;
    expect(result.url).toBe("blob:2");
    expect(shim.lastSignal).toBeDefined();
  });

  test("abortCurrent during renderManual aborts the signal", async () => {
    let captured: AbortSignal | undefined;
    const shim = {
      ...makeShim(),
      render: async (_id: number, _t: string, _v?: string, signal?: AbortSignal) => {
        captured = signal;
        // Wait for abort.
        return new Promise<{ url: string; durationMs: number }>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    };
    const c = new PlaybackController(shim as any);
    const p = c.renderManual(1, "x").catch((e) => e);
    expect(captured).toBeDefined();
    c.abortCurrent();
    expect(captured!.aborted).toBe(true);
    await p;
  });

  test("setVoice clears cache and aborts current", () => {
    const shim = makeShim();
    const c = new PlaybackController(shim as any);
    c.beginStream(1);
    c.setVoice("Sage");
    expect(shim.calls).toContain("cancelStream");
    expect(shim.calls).toContain("cache.clear");
    expect(c.state).toBe("idle");
  });

  test("setEnabled(false) aborts current playback", () => {
    const shim = makeShim();
    const c = new PlaybackController(shim as any);
    c.beginStream(1);
    c.setEnabled(false);
    expect(shim.calls).toContain("cancelStream");
    expect(c.state).toBe("idle");
  });
});
