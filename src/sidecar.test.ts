import { test, expect, describe, beforeEach, mock } from "bun:test";

// Module under test is loaded lazily inside tests so we can mock dependencies first.

describe("sidecar", () => {
  beforeEach(async () => {
    // Ensure real module is loaded and state is clean before each test.
    const mod = await import("./sidecar");
    mod.resetSidecarStateForTesting();
  });

  test("isNarrationReady starts false before sidecar boots", async () => {
    const { isNarrationReady, resetSidecarStateForTesting } = await import("./sidecar");
    resetSidecarStateForTesting();
    expect(isNarrationReady()).toBe(false);
  });

  test("waitForSidecarReady resolves true when /health reports ready", async () => {
    const { waitForSidecarReady, resetSidecarStateForTesting } = await import("./sidecar");
    resetSidecarStateForTesting();

    const origFetch = globalThis.fetch;
    let calls = 0;
    (globalThis as any).fetch = async (url: string) => {
      calls++;
      // First two calls report ready:false, third reports true (simulate model load)
      const ready = calls >= 3;
      return new Response(JSON.stringify({ ready, voices: ["noir"] }), { status: 200 });
    };

    try {
      const result = await waitForSidecarReady(5000, 50);
      expect(result).toBe(true);
      expect(calls).toBeGreaterThanOrEqual(3);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("waitForSidecarReady resolves false on timeout", async () => {
    const { waitForSidecarReady, resetSidecarStateForTesting } = await import("./sidecar");
    resetSidecarStateForTesting();

    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ ready: false, voices: [] }), { status: 200 });

    try {
      const result = await waitForSidecarReady(200, 50);
      expect(result).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("waitForSidecarReady handles fetch errors gracefully (keeps retrying)", async () => {
    const { waitForSidecarReady, resetSidecarStateForTesting } = await import("./sidecar");
    resetSidecarStateForTesting();

    const origFetch = globalThis.fetch;
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ ready: true, voices: ["noir"] }), { status: 200 });
    };

    try {
      const result = await waitForSidecarReady(5000, 50);
      expect(result).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("isNarrationReady reflects markSidecarReady", async () => {
    const { isNarrationReady, markSidecarReady, resetSidecarStateForTesting } = await import("./sidecar");
    resetSidecarStateForTesting();
    expect(isNarrationReady()).toBe(false);
    markSidecarReady(true);
    expect(isNarrationReady()).toBe(true);
    markSidecarReady(false);
    expect(isNarrationReady()).toBe(false);
  });
});
