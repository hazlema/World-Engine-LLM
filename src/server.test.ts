import { test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import * as engine from "./engine";
import { processInput, type ServerMessage } from "./server";
import type { WorldStack } from "./stack";

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
};

beforeEach(() => {
  interpreterSpy = spyOn(engine, "interpreterTurn");
  narratorSpy = spyOn(engine, "narratorTurn");
  archivistSpy = spyOn(engine, "archivistTurn");
});

afterEach(() => {
  interpreterSpy.mockRestore();
  narratorSpy.mockRestore();
  archivistSpy.mockRestore();
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
  }));

  const newStack = await processInput(emptyStack, "go north", () => {});

  expect(newStack.position).toEqual([1, 0]);
  expect(newStack.places["1,0"]).toBe("A windswept dune crowned by a single dead tree.");
});

test("processInput: blocked move (moved=false) keeps original position", async () => {
  interpreterSpy.mockImplementationOnce(async () => ({ action: "move-north" }));
  narratorSpy.mockImplementationOnce(async () => "A wall of thorns blocks the way.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: ["wall of thorns to the north"],
    threads: [],
    turn: 1,
    moved: false,
    locationDescription: "A flat expanse of sand.",
  }));

  const newStack = await processInput(emptyStack, "go north", () => {});

  expect(newStack.position).toEqual([0, 0]);
  expect(newStack.places["1,0"]).toBeUndefined();
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
  };
  interpreterSpy.mockImplementationOnce(async () => ({ action: "move-north" }));
  narratorSpy.mockImplementationOnce(async () => "You return to the dune.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 6,
    moved: true,
    locationDescription: "A windswept dune crowned by a single dead tree.",
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
  };
  interpreterSpy.mockImplementationOnce(async () => ({ action: "move-north" }));
  narratorSpy.mockImplementationOnce(async () => "You return.");
  archivistSpy.mockImplementationOnce(async () => ({
    entries: [],
    threads: [],
    turn: 6,
    moved: true,
    locationDescription: "DIFFERENT DESCRIPTION",
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

  expect(messages.length).toBe(2);
  expect(messages[0]).toEqual({ type: "turn-start", input: "look" });
  expect(messages[1]).toMatchObject({ type: "error", source: "narrator" });
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

  expect(messages.length).toBe(3);
  expect(messages[0]).toEqual({ type: "turn-start", input: "look" });
  expect(messages[1]).toEqual({ type: "narrative", text: "Something happens." });
  expect(messages[2]).toMatchObject({ type: "error", source: "archivist" });
  expect(newStack).toBe(emptyStack);
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
  }));

  const newStack = await processInput(emptyStack, "go north", () => {});

  expect(newStack.position).toEqual([0, 0]);
  // narrator was still called
  expect(narratorSpy).toHaveBeenCalled();
});
