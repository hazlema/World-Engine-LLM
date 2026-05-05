import { test, expect } from "bun:test";
import { formatStackForNarrator, formatStackForArchivist, posKey, applyDirection, type WorldStack } from "./stack";

test("formatStackForNarrator: empty stack returns empty string", () => {
  expect(formatStackForNarrator({ entries: [], threads: [], turn: 0, position: [0, 0] as [number, number], places: {} })).toBe("");
});

test("formatStackForNarrator: entries only", () => {
  const stack = { entries: ["world is cold", "crow watches"], threads: [], turn: 1, position: [0, 0] as [number, number], places: {} };
  expect(formatStackForNarrator(stack)).toBe(
    "ESTABLISHED WORLD:\n- world is cold\n- crow watches\n\n"
  );
});

test("formatStackForNarrator: threads only", () => {
  const stack = { entries: [], threads: ["find the missing watcher"], turn: 1, position: [0, 0] as [number, number], places: {} };
  expect(formatStackForNarrator(stack)).toBe(
    "ACTIVE THREADS:\n- find the missing watcher\n\n"
  );
});

test("formatStackForNarrator: entries and threads together", () => {
  const stack = {
    entries: ["world is cold"],
    threads: ["find the watcher"],
    turn: 1,
    position: [0, 0] as [number, number],
    places: {},
  };
  expect(formatStackForNarrator(stack)).toBe(
    "ESTABLISHED WORLD:\n- world is cold\n\nACTIVE THREADS:\n- find the watcher\n\n"
  );
});

test("formatStackForArchivist: empty stack returns empty headers for both", () => {
  expect(formatStackForArchivist({ entries: [], threads: [], turn: 0, position: [0, 0] as [number, number], places: {} })).toBe(
    "CURRENT STACK: (empty)\n\nACTIVE THREADS: (none)\n\n"
  );
});

test("formatStackForArchivist: populated stack", () => {
  const stack = {
    entries: ["world is cold"],
    threads: ["find the watcher"],
    turn: 2,
    position: [0, 0] as [number, number],
    places: {},
  };
  expect(formatStackForArchivist(stack)).toBe(
    "CURRENT STACK:\n- world is cold\n\nACTIVE THREADS:\n- find the watcher\n\n"
  );
});

test("posKey: serialises position to comma-separated string", () => {
  expect(posKey([0, 0])).toBe("0,0");
  expect(posKey([1, -2])).toBe("1,-2");
  expect(posKey([-3, 5])).toBe("-3,5");
});

test("applyDirection: north increments first coordinate", () => {
  expect(applyDirection([0, 0], "north")).toEqual([1, 0]);
});

test("applyDirection: south decrements first coordinate", () => {
  expect(applyDirection([0, 0], "south")).toEqual([-1, 0]);
});

test("applyDirection: east increments second coordinate", () => {
  expect(applyDirection([0, 0], "east")).toEqual([0, 1]);
});

test("applyDirection: west decrements second coordinate", () => {
  expect(applyDirection([0, 0], "west")).toEqual([0, -1]);
});

test("formatStackForNarrator: includes stored location description when present", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [1, 0],
    places: { "1,0": "A windswept dune crowned by a single dead tree." },
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("CURRENT LOCATION (canonical description):");
  expect(out).toContain("A windswept dune crowned by a single dead tree.");
});

test("formatStackForNarrator: omits the location section when no description stored", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
  };
  const out = formatStackForNarrator(stack);
  expect(out).not.toContain("CURRENT LOCATION (canonical description):");
});
