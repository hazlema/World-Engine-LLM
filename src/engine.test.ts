import { test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import * as api from "./api";
import { narratorTurn, archivistTurn, interpreterTurn, NARRATOR_SYSTEM } from "./engine";
import { MAX_STACK_ENTRIES, MAX_THREADS } from "./stack";
import type { WorldStack } from "./stack";

let callModelSpy: any;
let callModelStructuredSpy: any;

const emptyStack: WorldStack = { entries: [] as string[], threads: [] as string[], turn: 0, position: [0, 0] as [number, number], places: {}, objectives: [], presetSlug: null };
const populatedStack: WorldStack = {
  entries: ["world is cold", "crow watches"],
  threads: ["find the watcher"],
  turn: 2,
  position: [0, 0] as [number, number],
  places: {},
  objectives: [],
  presetSlug: null,
};

beforeEach(() => {
  callModelSpy = spyOn(api, "callModel");
  callModelStructuredSpy = spyOn(api, "callModelStructured");
});

afterEach(() => {
  callModelSpy.mockRestore();
  callModelStructuredSpy.mockRestore();
});

// narratorTurn tests

test("narratorTurn: returns narrative from callModel", async () => {
  callModelSpy.mockImplementationOnce(async () => "Dust drifts across cracked earth.");
  const result = await narratorTurn(emptyStack, "look around");
  expect(result).toBe("Dust drifts across cracked earth.");
});

test("narratorTurn: strips asterisk emphasis from narrator output", async () => {
  callModelSpy.mockImplementationOnce(async () => "A faint *ping* echoes; the lock holds **firm**.");
  const result = await narratorTurn(emptyStack, "use key");
  expect(result).toBe("A faint ping echoes; the lock holds firm.");
  expect(result).not.toContain("*");
});

test("narratorTurn: propagates callModel rejection", async () => {
  callModelSpy.mockImplementationOnce(async () => {
    throw new Error("API timeout");
  });
  await expect(narratorTurn(emptyStack, "look around")).rejects.toThrow("API timeout");
});

test("narratorTurn: omits ESTABLISHED WORLD on empty stack", async () => {
  let capturedInput = "";
  callModelSpy.mockImplementationOnce(async (_sys: string, inp: string) => {
    capturedInput = inp;
    return "Something happens.";
  });
  await narratorTurn(emptyStack, "look around");
  expect(capturedInput).toBe("PLAYER ACTION: look around");
  expect(capturedInput).not.toContain("ESTABLISHED WORLD");
  expect(capturedInput).not.toContain("ACTIVE THREADS");
});

test("narratorTurn: includes ESTABLISHED WORLD and ACTIVE THREADS on populated stack", async () => {
  let capturedInput = "";
  callModelSpy.mockImplementationOnce(async (_sys: string, inp: string) => {
    capturedInput = inp;
    return "Something happens.";
  });
  await narratorTurn(populatedStack, "look around");
  expect(capturedInput).toContain("ESTABLISHED WORLD:");
  expect(capturedInput).toContain("- world is cold");
  expect(capturedInput).toContain("ACTIVE THREADS:");
  expect(capturedInput).toContain("- find the watcher");
  expect(capturedInput).toContain("PLAYER ACTION: look around");
});

// archivistTurn tests

test("archivistTurn: returns updated WorldStack with entries, threads, and incremented turn", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({
    entries: ["new fact one", "new fact two"],
    threads: ["new thread one"],
  }));
  const result = await archivistTurn(emptyStack, "The crow flew away.");
  expect(result.entries).toEqual(["new fact one", "new fact two"]);
  expect(result.threads).toEqual(["new thread one"]);
  expect(result.turn).toBe(1);
});

test("archivistTurn: caps entries at MAX_STACK_ENTRIES", async () => {
  const manyEntries = Array.from({ length: 30 }, (_, i) => `fact ${i}`);
  callModelStructuredSpy.mockImplementationOnce(async () => ({
    entries: manyEntries,
    threads: [],
  }));
  const result = await archivistTurn(emptyStack, "narrative");
  expect(result.entries.length).toBe(MAX_STACK_ENTRIES);
});

test("archivistTurn: caps threads at MAX_THREADS", async () => {
  const manyThreads = Array.from({ length: 20 }, (_, i) => `thread ${i}`);
  callModelStructuredSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: manyThreads,
  }));
  const result = await archivistTurn(emptyStack, "narrative");
  expect(result.threads.length).toBe(MAX_THREADS);
});

test("archivistTurn: uses empty headers for empty stack", async () => {
  let capturedInput = "";
  callModelStructuredSpy.mockImplementationOnce(async (_sys: string, inp: string) => {
    capturedInput = inp;
    return { entries: [] as string[], threads: [] as string[] };
  });
  await archivistTurn(emptyStack, "Some narrative.");
  expect(capturedInput).toContain("CURRENT STACK: (empty)");
  expect(capturedInput).toContain("ACTIVE THREADS: (none)");
});

test("archivistTurn: includes populated stack and threads in archivist input", async () => {
  let capturedInput = "";
  callModelStructuredSpy.mockImplementationOnce(async (_sys: string, inp: string) => {
    capturedInput = inp;
    return { entries: [] as string[], threads: [] as string[] };
  });
  await archivistTurn(populatedStack, "Some narrative.");
  expect(capturedInput).toContain("CURRENT STACK:");
  expect(capturedInput).toContain("- world is cold");
  expect(capturedInput).toContain("- crow watches");
  expect(capturedInput).toContain("ACTIVE THREADS:");
  expect(capturedInput).toContain("- find the watcher");
});

test("archivistTurn: throws on non-array entries response", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({
    entries: "not an array" as unknown as string[],
    threads: [],
  }));
  await expect(archivistTurn(emptyStack, "narrative")).rejects.toThrow(
    "Archivist returned unexpected shape"
  );
});

test("archivistTurn: throws on non-array threads response", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: "not an array" as unknown as string[],
  }));
  await expect(archivistTurn(emptyStack, "narrative")).rejects.toThrow(
    "Archivist returned unexpected shape"
  );
});

test("interpreterTurn: classifies 'go north' as move-north", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({ action: "move-north" }));
  const result = await interpreterTurn("go north");
  expect(result).toEqual({ action: "move-north" });
});

test("interpreterTurn: classifies 'look around' as stay", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  const result = await interpreterTurn("look around");
  expect(result).toEqual({ action: "stay" });
});

test("interpreterTurn: passes the player input to the structured call", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  await interpreterTurn("head west toward the dunes");
  // 4th call arg is the schema; 2nd arg is the input
  expect(callModelStructuredSpy.mock.calls[0][1]).toContain("head west toward the dunes");
});

test("interpreterTurn: defaults to stay when API returns an unknown action", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({ action: "invalid" as any }));
  const result = await interpreterTurn("?????");
  expect(result).toEqual({ action: "stay" });
});

test("NARRATOR_SYSTEM: instructs the narrator to honor a canonical location description", () => {
  expect(NARRATOR_SYSTEM).toContain("CURRENT LOCATION");
  expect(NARRATOR_SYSTEM.toLowerCase()).toMatch(/honor|consistent|do not contradict/);
});

test("archivistTurn: returns moved and locationDescription fields", async () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
  };
  callModelStructuredSpy.mockImplementationOnce(async () => ({
    entries: ["dune"],
    threads: [],
    moved: true,
    locationDescription: "A windswept dune.",
  }));
  const result = await archivistTurn(stack, "narrative");
  expect(result.moved).toBe(true);
  expect(result.locationDescription).toBe("A windswept dune.");
  expect(result.entries).toEqual(["dune"]);
  expect(result.turn).toBe(1);
});

test("archivistTurn: missing moved/locationDescription default safely", async () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
  };
  callModelStructuredSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
  } as any));
  const result = await archivistTurn(stack, "narrative");
  expect(result.moved).toBe(false);
  expect(result.locationDescription).toBe("");
});

test("narratorTurn: omits MISSION BRIEFING when briefing is undefined", async () => {
  let captured = "";
  callModelSpy.mockImplementationOnce(async (_sys: string, inp: string) => {
    captured = inp;
    return "ok";
  });
  await narratorTurn(emptyStack, "look");
  expect(captured).not.toContain("MISSION BRIEFING");
});

test("narratorTurn: includes MISSION BRIEFING and OBJECTIVES when provided", async () => {
  const stackWithObjectives: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [{ text: "Find the transmitter", achieved: false }],
    presetSlug: "lunar-rescue",
  };
  let captured = "";
  callModelSpy.mockImplementationOnce(async (_sys: string, inp: string) => {
    captured = inp;
    return "ok";
  });
  await narratorTurn(stackWithObjectives, "look", "You are an astronaut.");
  expect(captured).toContain("MISSION BRIEFING (durable premise):");
  expect(captured).toContain("You are an astronaut.");
  expect(captured).toContain("OBJECTIVES (active this turn):");
  expect(captured).toContain("[ ] Find the transmitter");
});

test("NARRATOR_SYSTEM: instructs the narrator to honor the mission briefing", () => {
  expect(NARRATOR_SYSTEM).toContain("MISSION BRIEFING");
  expect(NARRATOR_SYSTEM).toContain("OBJECTIVES");
});

test("archivistTurn: returns achievedObjectiveIndices from model", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [0, 2],
  }));
  const result = await archivistTurn(emptyStack, "narrative");
  expect(result.achievedObjectiveIndices).toEqual([0, 2]);
});

test("archivistTurn: defaults achievedObjectiveIndices to [] when missing", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    moved: false,
    locationDescription: "",
  } as any));
  const result = await archivistTurn(emptyStack, "narrative");
  expect(result.achievedObjectiveIndices).toEqual([]);
});

test("archivistTurn: filters non-integer or negative achievedObjectiveIndices", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [0, -1, 1.5, 3, "bad" as any],
  }));
  const result = await archivistTurn(emptyStack, "narrative");
  expect(result.achievedObjectiveIndices).toEqual([0, 3]);
});

test("ARCHIVIST_SYSTEM: instructs the archivist on conservative objective completion", async () => {
  const { ARCHIVIST_SYSTEM } = await import("./engine");
  expect(ARCHIVIST_SYSTEM).toContain("achievedObjectiveIndices");
  expect(ARCHIVIST_SYSTEM.toLowerCase()).toContain("when in doubt");
});
