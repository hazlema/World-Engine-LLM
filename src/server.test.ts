import { test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import * as engine from "./engine";
import { processInput, startWithPreset, keepExploring, emptyWorld, snapshotMessage, resetServerConfigForTesting, setPresetsForTesting, presetBannerResponse, type ServerMessage, type Send } from "./server";
import { resetConfigForTesting } from "./api";
import type { WorldStack } from "./stack";
import type { Preset } from "./presets";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tts from "./tts";

let interpreterSpy: any;
let narratorSpy: any;
let archivistSpy: any;

const emptyStack: WorldStack = {
  entries: [],
  threads: [],
  turn: 0,
  position: [0, 0],
  places: {},
  objectives: [],
  presetSlug: null,
  attributes: [],
};

beforeEach(() => {
  process.env.NARRATOR_PROVIDER = "local,test-model";
  process.env.ARCHIVIST_PROVIDER = "local,test-model";
  process.env.INTERPRETER_PROVIDER = "local,test-model";
  resetConfigForTesting();
  resetServerConfigForTesting();
  interpreterSpy = spyOn(engine, "interpreterTurn");
  narratorSpy = spyOn(engine, "narratorTurn");
  archivistSpy = spyOn(engine, "archivistTurn");
});

afterEach(() => {
  interpreterSpy.mockRestore();
  narratorSpy.mockRestore();
  archivistSpy.mockRestore();
  delete process.env.NARRATOR_PROVIDER;
  delete process.env.ARCHIVIST_PROVIDER;
  delete process.env.INTERPRETER_PROVIDER;
  delete process.env.GEMINI_API_KEY;
  delete process.env.USE_NARRATION;
  delete process.env.USE_GEMINI_IMAGES;
  resetConfigForTesting();
  resetServerConfigForTesting();
});

test("processInput: stay action does not change position", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "You look around.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: ["sand"],
    threads: [],
    turn: 1,
    moved: false,
    locationDescription: "A flat expanse of sand.",
    achievedObjectiveIndices: [],
  }));

  const messages: ServerMessage[] = [];
  const newStack = await processInput(emptyStack, "look around", (m) => messages.push(m));

  expect(newStack.position).toEqual([0, 0]);
  expect(newStack.places["0,0"]).toBe("A flat expanse of sand.");
});

test("processInput: successful move updates position and captures new place", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "move-north" }));
  narratorSpy.mockImplementationOnce(async () => "You walk north into the dunes.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 1,
    moved: true,
    locationDescription: "A windswept dune crowned by a single dead tree.",
    achievedObjectiveIndices: [],
  }));

  const newStack = await processInput(emptyStack, "go north", () => {});

  expect(newStack.position).toEqual([1, 0]);
  expect(newStack.places["1,0"]).toBe("A windswept dune crowned by a single dead tree.");
});

test("processInput: move-{cardinal} updates position even when archivist sets moved=false", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "move-north" }));
  narratorSpy.mockImplementationOnce(async () => "Regolith crunches as you climb the slope.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 1,
    moved: false,
    locationDescription: "A windswept dune.",
    achievedObjectiveIndices: [],
  }));

  const newStack = await processInput(emptyStack, "north", () => {});

  expect(newStack.position).toEqual([1, 0]);
  expect(newStack.places["1,0"]).toBe("A windswept dune.");
});

test("processInput: narrator receives the target tile's stored description as anchor", async () => {
  const stackWithKnownPlace: WorldStack = {
    entries: [],
    threads: [],
    turn: 5,
    position: [0, 0],
    places: { "1,0": "A windswept dune crowned by a single dead tree." },
    objectives: [],
    presetSlug: null,
    attributes: [],
  };
  interpreterSpy.mockImplementationOnce(async () => ({ action: "move-north" }));
  narratorSpy.mockImplementationOnce(async () => "You return to the dune.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 6,
    moved: true,
    locationDescription: "A windswept dune crowned by a single dead tree.",
    achievedObjectiveIndices: [],
  }));

  await processInput(stackWithKnownPlace, "north", () => {});

  // Narrator should have been called with a stack whose position is [1,0]
  // so formatStackForNarrator surfaces the canonical description.
  const stackPassedToNarrator = narratorSpy.mock.calls[0][0] as WorldStack;
  expect(stackPassedToNarrator.position).toEqual([1, 0]);
});

test("processInput: return visit does NOT overwrite stored description", async () => {
  const stackWithKnownPlace: WorldStack = {
    entries: [],
    threads: [],
    turn: 5,
    position: [0, 0],
    places: { "1,0": "ORIGINAL DESCRIPTION" },
    objectives: [],
    presetSlug: null,
    attributes: [],
  };
  interpreterSpy.mockImplementationOnce(async () => ({ action: "move-north" }));
  narratorSpy.mockImplementationOnce(async () => "You return.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 6,
    moved: true,
    locationDescription: "DIFFERENT DESCRIPTION",
    achievedObjectiveIndices: [],
  }));

  const newStack = await processInput(stackWithKnownPlace, "north", () => {});

  expect(newStack.places["1,0"]).toBe("ORIGINAL DESCRIPTION");
});

test("processInput: emits turn-start, narrative, stack-update on happy path", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "The world stirs.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: ["world stirred"],
    threads: ["find the cause"],
    turn: 1,
    moved: false,
    locationDescription: "An empty void.",
    achievedObjectiveIndices: [],
  }));

  const messages: ServerMessage[] = [];
  await processInput(emptyStack, "look", (m) => messages.push(m));

  expect(messages[0]).toEqual({ type: "turn-start", input: "look" });
  expect(messages[1]).toEqual({ type: "narrative", text: "The world stirs." });
  expect(messages[2]).toMatchObject({
    type: "stack-update",
    entries: ["world stirred"],
    threads: ["find the cause"],
  });
});

test("processInput: on narrator failure, emits error and returns unchanged stack", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => {
    throw new Error("API timeout");
  });

  const messages: ServerMessage[] = [];
  const newStack = await processInput(emptyStack, "look", (m) => messages.push(m));

  expect(messages.length).toBe(3);
  expect(messages[0]).toEqual({ type: "turn-start", input: "look" });
  expect(messages[1]).toMatchObject({ type: "error", source: "narrator" });
  expect(messages[2]).toMatchObject({ type: "debug-trace" });
  expect(newStack).toBe(emptyStack);
  expect(archivistSpy).not.toHaveBeenCalled();
});

test("processInput: on archivist failure, narrative is sent but stack is unchanged", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "Something happens.");
  archivistSpy.mockImplementationOnce(async () => {
    throw new Error("schema mismatch");
  });

  const messages: ServerMessage[] = [];
  const newStack = await processInput(emptyStack, "look", (m) => messages.push(m));

  expect(messages.length).toBe(4);
  expect(messages[0]).toEqual({ type: "turn-start", input: "look" });
  expect(messages[1]).toEqual({ type: "narrative", text: "Something happens." });
  expect(messages[2]).toMatchObject({ type: "error", source: "archivist" });
  expect(messages[3]).toMatchObject({ type: "debug-trace" });
  expect(newStack).toBe(emptyStack);
});

test("processInput: emits debug-trace with null archivist on move-blocked", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "move-blocked" }));

  const messages: ServerMessage[] = [];
  await processInput(emptyStack, "go through wall", (m) => messages.push(m));

  const traceMsg = messages.find((m) => m.type === "debug-trace");
  expect(traceMsg).toBeDefined();
  if (traceMsg?.type !== "debug-trace") throw new Error("type guard");
  expect(traceMsg.trace.input).toBe("go through wall");
  expect(traceMsg.trace.interpreter.action).toBe("move-blocked");
  expect(traceMsg.trace.archivist).toBeNull();
});

test("processInput: on interpreter failure, falls back to stay (still runs narrator)", async () => {
  interpreterSpy.mockImplementationOnce(async () => {
    throw new Error("interpreter API error");
  });
  narratorSpy.mockImplementationOnce(async () => "ok");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 1,
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [],
  }));

  const messages: ServerMessage[] = [];
  const newStack = await processInput(emptyStack, "go north", (m) => messages.push(m));

  expect(newStack.position).toEqual([0, 0]);
  // narrator was still called
  expect(narratorSpy).toHaveBeenCalled();
  // interpreter exceptions must not surface as move-blocked
  expect(messages.some((m) => m.type === "move-blocked")).toBe(false);
});

const lunarPreset: Preset = {
  slug: "lunar-rescue",
  title: "Lunar Rescue",
  description: "test",
  objects: ["damaged transmitter", "oxygen cache"],
  objectives: [
    { text: "Find the transmitter" },
    { text: "Send the signal" },
  ],
  attributes: [],
  body: "You are an astronaut.",
};

test("startWithPreset: seeds a stack from the preset", () => {
  const s = startWithPreset(lunarPreset);
  expect(s.entries).toEqual(["damaged transmitter", "oxygen cache"]);
  expect(s.objectives).toEqual([
    { text: "Find the transmitter", achieved: false },
    { text: "Send the signal", achieved: false },
  ]);
  expect(s.presetSlug).toBe("lunar-rescue");
  expect(s.turn).toBe(0);
  expect(s.position).toEqual([0, 0]);
});

test("emptyWorld: returns a fresh empty stack", () => {
  const s = emptyWorld();
  expect(s.entries).toEqual([]);
  expect(s.threads).toEqual([]);
  expect(s.objectives).toEqual([]);
  expect(s.presetSlug).toBeNull();
  expect(s.turn).toBe(0);
  expect(s.position).toEqual([0, 0]);
  expect(s.places).toEqual({});
});

test("keepExploring: clears presetSlug, leaves objectives intact", () => {
  const s: WorldStack = {
    entries: ["x"],
    threads: ["y"],
    turn: 5,
    position: [1, 0],
    places: { "1,0": "p" },
    objectives: [
      { text: "a", achieved: true },
      { text: "b", achieved: true },
    ],
    presetSlug: "lunar-rescue",
    attributes: [],
  };
  const after = keepExploring(s);
  expect(after.presetSlug).toBeNull();
  expect(after.objectives).toEqual(s.objectives);
  expect(after.entries).toEqual(s.entries);
  expect(after.turn).toBe(5);
});

test("processInput: stack-update includes objectives", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "ok");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 1,
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [],
  }));
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [{ text: "a", achieved: false }],
    presetSlug: "x",
    attributes: [],
  };
  const messages: ServerMessage[] = [];
  await processInput(stack, "look", (m) => messages.push(m));
  const update = messages.find((m) => m.type === "stack-update");
  expect(update).toBeDefined();
  if (update?.type === "stack-update") {
    expect(update.objectives).toEqual([{ text: "a", achieved: false }]);
  }
});

test("processInput: applies achievedObjectiveIndices monotonically", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "ok");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 1,
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [0],
  }));
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [
      { text: "a", achieved: false },
      { text: "b", achieved: false },
    ],
    presetSlug: "x",
    attributes: [],
  };
  const newStack = await processInput(stack, "look", () => {});
  expect(newStack.objectives).toEqual([
    { text: "a", achieved: true },
    { text: "b", achieved: false },
  ]);
});

test("processInput: emits win when last objective is achieved", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "ok");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 1,
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [1],
  }));
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [
      { text: "a", achieved: true },
      { text: "b", achieved: false },
    ],
    presetSlug: "x",
    attributes: [],
  };
  const messages: ServerMessage[] = [];
  await processInput(stack, "look", (m) => messages.push(m));
  expect(messages.some((m) => m.type === "win")).toBe(true);
});

test("processInput: does NOT re-emit win on subsequent turns when already won", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "ok");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 2,
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [],
  }));
  const alreadyWon: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [
      { text: "a", achieved: true },
      { text: "b", achieved: true },
    ],
    presetSlug: "x",
    attributes: [],
  };
  const messages: ServerMessage[] = [];
  await processInput(alreadyWon, "look", (m) => messages.push(m));
  expect(messages.some((m) => m.type === "win")).toBe(false);
});

test("processInput: free-play (no objectives) never emits win", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "ok");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 1,
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [],
  }));
  const messages: ServerMessage[] = [];
  await processInput(emptyStack, "look", (m) => messages.push(m));
  expect(messages.some((m) => m.type === "win")).toBe(false);
});

test("processInput: move-blocked short-circuits, no narrator/archivist call, sends move-blocked message", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "move-blocked" }));

  const messages: ServerMessage[] = [];
  const newStack = await processInput(emptyStack, "go to the train", (m) => messages.push(m));

  expect(narratorSpy).not.toHaveBeenCalled();
  expect(archivistSpy).not.toHaveBeenCalled();
  expect(newStack).toBe(emptyStack);
  expect(messages[0]).toEqual({ type: "move-blocked", input: "go to the train" });
  expect(messages[1]?.type).toBe("debug-trace");
});

test("processInput: emits debug-trace with error when archivist throws", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  narratorSpy.mockImplementationOnce(async () => "You stand still.");
  archivistSpy.mockImplementationOnce(async () => { throw new Error("boom"); });

  const messages: ServerMessage[] = [];
  await processInput(emptyStack, "wait", (m) => messages.push(m));

  const traceMsg = messages.find((m) => m.type === "debug-trace");
  expect(traceMsg).toBeDefined();
  if (traceMsg?.type !== "debug-trace") throw new Error("type guard");
  expect(traceMsg.trace.archivist).toBeNull();
  expect(traceMsg.trace.error?.source).toBe("archivist");
  expect(traceMsg.trace.error?.message).toContain("boom");
});

test("processInput: emits debug-trace after stack-update on normal turn", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "move-north" }));
  narratorSpy.mockImplementationOnce(async () => "You walk north.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: ["a tall pine"],
    threads: ["who carved the pine?"],
    turn: 1,
    moved: true,
    locationDescription: "A clearing under tall pines.",
    achievedObjectiveIndices: [2],
  }));

  const messages: ServerMessage[] = [];
  await processInput(emptyStack, "north", (m) => messages.push(m));

  const stackUpdateIdx = messages.findIndex((m) => m.type === "stack-update");
  const traceIdx = messages.findIndex((m) => m.type === "debug-trace");

  expect(stackUpdateIdx).toBeGreaterThanOrEqual(0);
  expect(traceIdx).toBeGreaterThan(stackUpdateIdx);

  const trace = messages[traceIdx];
  if (!trace || trace.type !== "debug-trace") throw new Error("type guard");
  expect(trace.trace.input).toBe("north");
  expect(trace.trace.interpreter.action).toBe("move-north");
  expect(trace.trace.archivist).toEqual({
    entries: ["a tall pine"],
    threads: ["who carved the pine?"],
    achievedObjectiveIndices: [2],
    moved: true,
    locationDescription: "A clearing under tall pines.",
  });
  expect(trace.trace.error).toBeUndefined();
});

test("snapshotMessage: includes providers info", () => {
  const msg = snapshotMessage(emptyStack);
  expect(msg.type).toBe("snapshot");
  if (msg.type !== "snapshot") throw new Error("type guard");
  expect(msg.providers).toBeDefined();
  expect(msg.providers.interpreter.provider).toMatch(/^(local|openrouter)$/);
  expect(typeof msg.providers.narrator.model).toBe("string");
  expect(typeof msg.providers.tts.voice).toBe("string");
  expect(typeof msg.providers.image.style).toBe("string");
  expect(msg.providers.useGeminiImages).toBe(false);
  expect(msg.providers.useNarration).toBe(true);
});

test("processInput: TTS audio-ready message goes through sendAudio (unicast), not send (broadcast)", async () => {
  // Need a working sidecar + isNarrationReady for the gate.
  process.env.USE_NARRATION = "true";
  process.env.NARRATOR_PROVIDER = "local,test-model";
  process.env.ARCHIVIST_PROVIDER = "local,test-model";
  process.env.INTERPRETER_PROVIDER = "local,test-model";

  const { resetConfigForTesting: resetCfg } = await import("./api");
  const { resetServerConfigForTesting: resetSrvCfg } = await import("./server");
  const { resetSidecarStateForTesting, markSidecarReady } = await import("./sidecar");
  resetCfg();
  resetSrvCfg();
  resetSidecarStateForTesting();
  markSidecarReady(true);

  // Mock synthesizeToFile using spyOn so the export can be intercepted.
  const ttsModule = await import("./tts");
  const ttsSpy = spyOn(ttsModule, "synthesizeToFile").mockResolvedValue("/media/audio/abc123.wav");

  try {
    const { processInput } = await import("./server");
    const engineModule = await import("./engine");

    spyOn(engineModule, "interpreterTurn").mockResolvedValue({ action: "stay" } as any);
    spyOn(engineModule, "narratorTurn").mockResolvedValue("Narration.");
    spyOn(engineModule, "archivistTurn").mockResolvedValue({
      entries: [], threads: [], turn: 1, moved: false,
      locationDescription: "", achievedObjectiveIndices: [],
    } as any);

    const broadcasts: any[] = [];
    const unicasts: any[] = [];
    const baseStack: any = {
      entries: [], threads: [], turn: 0, position: [0, 0],
      places: {}, objectives: [], presetSlug: null,
    };

    await processInput(
      baseStack,
      "look",
      (m) => broadcasts.push(m),
      undefined,
      "noir",
      (m) => unicasts.push(m),
    );

    const audioOnBroadcast = broadcasts.filter((m) => m.type === "audio-ready");
    const audioOnUnicast = unicasts.filter((m) => m.type === "audio-ready");
    expect(audioOnBroadcast).toEqual([]);
    expect(audioOnUnicast.length).toBe(1);
    expect(audioOnUnicast[0]).toEqual({
      type: "audio-ready",
      turnId: 1,
      url: "/media/audio/abc123.wav",
    });
  } finally {
    ttsSpy.mockRestore();
  }
});

test("snapshotMessage: includes hasBanner=true for presets with bannerPath", () => {
  setPresetsForTesting(new Map<string, Preset>([
    ["a", { slug: "a", title: "A", description: "d", objects: ["x"], objectives: [{ text: "o" }], attributes: [], body: "b", bannerPath: "/tmp/a.png" }],
    ["b", { slug: "b", title: "B", description: "d", objects: ["x"], objectives: [{ text: "o" }], attributes: [], body: "b" }],
  ]));
  const msg = snapshotMessage(emptyStack);
  if (msg.type !== "snapshot") throw new Error("expected snapshot");
  const byslug = new Map(msg.presets.map((p) => [p.slug, p]));
  expect(byslug.get("a")?.hasBanner).toBe(true);
  expect(byslug.get("b")?.hasBanner).toBe(false);
});

test("presetBannerResponse: 404 when slug unknown", async () => {
  setPresetsForTesting(new Map());
  const res = await presetBannerResponse("nope");
  expect(res.status).toBe(404);
});

test("presetBannerResponse: 404 when preset has no banner", async () => {
  setPresetsForTesting(new Map<string, Preset>([
    ["x", { slug: "x", title: "X", description: "d", objects: ["o"], objectives: [{ text: "o" }], attributes: [], body: "b" }],
  ]));
  const res = await presetBannerResponse("x");
  expect(res.status).toBe(404);
});

test("presetBannerResponse: 404 when bannerPath points to a missing file", async () => {
  setPresetsForTesting(new Map<string, Preset>([
    ["x", { slug: "x", title: "X", description: "d", objects: ["o"], objectives: [{ text: "o" }], attributes: [], body: "b", bannerPath: "/tmp/does-not-exist-banner.png" }],
  ]));
  const res = await presetBannerResponse("x");
  expect(res.status).toBe(404);
});

test("presetBannerResponse: serves png with correct Content-Type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banner-"));
  try {
    const path = join(dir, "x.png");
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(path, bytes);
    setPresetsForTesting(new Map<string, Preset>([
      ["x", { slug: "x", title: "X", description: "d", objects: ["o"], objectives: [{ text: "o" }], attributes: [], body: "b", bannerPath: path }],
    ]));
    const res = await presetBannerResponse("x");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf).toEqual(bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("presetBannerResponse: serves jpg with image/jpeg Content-Type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banner-"));
  try {
    const path = join(dir, "x.jpg");
    await writeFile(path, new Uint8Array([0xff, 0xd8, 0xff]));
    setPresetsForTesting(new Map<string, Preset>([
      ["x", { slug: "x", title: "X", description: "d", objects: ["o"], objectives: [{ text: "o" }], attributes: [], body: "b", bannerPath: path }],
    ]));
    const res = await presetBannerResponse("x");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("presetBannerResponse: serves webp with image/webp Content-Type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banner-"));
  try {
    const path = join(dir, "x.webp");
    await writeFile(path, new Uint8Array([0x52, 0x49, 0x46, 0x46]));
    setPresetsForTesting(new Map<string, Preset>([
      ["x", { slug: "x", title: "X", description: "d", objects: ["o"], objectives: [{ text: "o" }], attributes: [], body: "b", bannerPath: path }],
    ]));
    const res = await presetBannerResponse("x");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("handleClientMessage render-audio: synthesizes and sends audio-ready", async () => {
  const ttsSpy = spyOn(tts, "synthesizeToFile").mockResolvedValue("/media/audio/abc.wav");
  process.env.USE_NARRATION = "true";
  resetServerConfigForTesting();
  const { handleClientMessage } = await import("./server");
  const sent: ServerMessage[] = [];
  const send: Send = (m) => sent.push(m);
  await handleClientMessage(
    JSON.stringify({ type: "render-audio", turnId: 1, text: "hello world", voice: "noir" }),
    send,
    send,
  );
  expect(ttsSpy).toHaveBeenCalledWith("hello world", "noir");
  expect(sent).toContainEqual({ type: "audio-ready", turnId: 1, url: "/media/audio/abc.wav" });
  ttsSpy.mockRestore();
});

test("handleClientMessage render-audio: rejects empty text", async () => {
  process.env.USE_NARRATION = "true";
  resetServerConfigForTesting();
  const { handleClientMessage } = await import("./server");
  const sent: ServerMessage[] = [];
  const send: Send = (m) => sent.push(m);
  await handleClientMessage(
    JSON.stringify({ type: "render-audio", turnId: 1, text: "  ", voice: "noir" }),
    send,
    send,
  );
  expect(sent).toContainEqual({ type: "audio-error", turnId: 1, message: "empty text" });
});

test("handleClientMessage render-audio: rejects text over 8000 chars", async () => {
  process.env.USE_NARRATION = "true";
  resetServerConfigForTesting();
  const { handleClientMessage } = await import("./server");
  const sent: ServerMessage[] = [];
  const send: Send = (m) => sent.push(m);
  const huge = "x".repeat(8001);
  await handleClientMessage(
    JSON.stringify({ type: "render-audio", turnId: 1, text: huge, voice: "noir" }),
    send,
    send,
  );
  expect(sent).toContainEqual({ type: "audio-error", turnId: 1, message: "text too long" });
});

test("handleClientMessage render-audio: rejects when narration disabled", async () => {
  process.env.USE_NARRATION = "false";
  resetServerConfigForTesting();
  const { handleClientMessage } = await import("./server");
  const sent: ServerMessage[] = [];
  const send: Send = (m) => sent.push(m);
  await handleClientMessage(
    JSON.stringify({ type: "render-audio", turnId: 1, text: "hello", voice: "noir" }),
    send,
    send,
  );
  expect(sent).toContainEqual({ type: "audio-error", turnId: 1, message: "narration disabled" });
});

test("handleClientMessage render-audio: forwards synthesis errors", async () => {
  const ttsSpy = spyOn(tts, "synthesizeToFile").mockRejectedValue(new Error("sidecar boom"));
  process.env.USE_NARRATION = "true";
  resetServerConfigForTesting();
  const { handleClientMessage } = await import("./server");
  const sent: ServerMessage[] = [];
  const send: Send = (m) => sent.push(m);
  await handleClientMessage(
    JSON.stringify({ type: "render-audio", turnId: 1, text: "hello", voice: "noir" }),
    send,
    send,
  );
  expect(sent.some((m) => m.type === "audio-error" && m.message.includes("sidecar boom"))).toBe(true);
  ttsSpy.mockRestore();
});
