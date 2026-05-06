import { test, expect } from "bun:test";
import { formatStackForNarrator, formatStackForArchivist, posKey, applyDirection, applyPresetToStack, unionAchievedIndices, parseStackData, partitionObjectivesByReach, type WorldStack } from "./stack";
import type { Preset } from "./presets";

test("formatStackForNarrator: empty stack returns empty string", () => {
  expect(formatStackForNarrator({ entries: [], threads: [], turn: 0, position: [0, 0] as [number, number], places: {}, objectives: [], presetSlug: null })).toBe("");
});

test("formatStackForNarrator: entries only", () => {
  const stack = { entries: ["world is cold", "crow watches"], threads: [], turn: 1, position: [0, 0] as [number, number], places: {}, objectives: [], presetSlug: null };
  expect(formatStackForNarrator(stack)).toBe(
    "ESTABLISHED WORLD:\n- world is cold\n- crow watches\n\n"
  );
});

test("formatStackForNarrator: threads only", () => {
  const stack = { entries: [], threads: ["find the missing watcher"], turn: 1, position: [0, 0] as [number, number], places: {}, objectives: [], presetSlug: null };
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
    objectives: [],
    presetSlug: null,
  };
  expect(formatStackForNarrator(stack)).toBe(
    "ESTABLISHED WORLD:\n- world is cold\n\nACTIVE THREADS:\n- find the watcher\n\n"
  );
});

test("formatStackForArchivist: empty stack returns empty headers for both", () => {
  expect(formatStackForArchivist({ entries: [], threads: [], turn: 0, position: [0, 0] as [number, number], places: {}, objectives: [], presetSlug: null })).toBe(
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
    objectives: [],
    presetSlug: null,
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
    objectives: [],
    presetSlug: null,
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
    objectives: [],
    presetSlug: null,
  };
  const out = formatStackForNarrator(stack);
  expect(out).not.toContain("CURRENT LOCATION (canonical description):");
});

const samplePreset: Preset = {
  slug: "lunar-rescue",
  title: "Lunar Rescue",
  description: "test",
  objects: ["damaged transmitter", "oxygen cache"],
  objectives: [
    { text: "Find the transmitter" },
    { text: "Send the signal" },
  ],
  body: "You are an astronaut.",
};

test("applyPresetToStack: seeds entries from objects, objectives from objectives, sets slug", () => {
  const s = applyPresetToStack(samplePreset);
  expect(s.entries).toEqual(["damaged transmitter", "oxygen cache"]);
  expect(s.threads).toEqual([]);
  expect(s.turn).toBe(0);
  expect(s.position).toEqual([0, 0]);
  expect(s.places).toEqual({});
  expect(s.presetSlug).toBe("lunar-rescue");
  expect(s.objectives).toEqual([
    { text: "Find the transmitter", achieved: false },
    { text: "Send the signal", achieved: false },
  ]);
});

test("applyPresetToStack: forwards objective position from preset", () => {
  const preset: Preset = {
    slug: "demo",
    title: "Demo",
    description: "test",
    objects: [],
    objectives: [
      { text: "Open chest", position: [1, 0] },
      { text: "Wander" },
    ],
    body: "body",
  };
  const s = applyPresetToStack(preset);
  expect(s.objectives).toEqual([
    { text: "Open chest", achieved: false, position: [1, 0] },
    { text: "Wander", achieved: false },
  ]);
});

test("unionAchievedIndices: flips named indices to achieved", () => {
  const before = [
    { text: "a", achieved: false },
    { text: "b", achieved: false },
    { text: "c", achieved: false },
  ];
  const after = unionAchievedIndices(before, [1]);
  expect(after).toEqual([
    { text: "a", achieved: false },
    { text: "b", achieved: true },
    { text: "c", achieved: false },
  ]);
});

test("unionAchievedIndices: monotonic — already-achieved stays achieved when index not present", () => {
  const before = [
    { text: "a", achieved: true },
    { text: "b", achieved: false },
  ];
  const after = unionAchievedIndices(before, [1]);
  expect(after).toEqual([
    { text: "a", achieved: true },
    { text: "b", achieved: true },
  ]);
});

test("unionAchievedIndices: ignores out-of-range and non-integer indices", () => {
  const before = [{ text: "a", achieved: false }];
  const after = unionAchievedIndices(before, [5, -1, 1.5 as unknown as number]);
  expect(after).toEqual([{ text: "a", achieved: false }]);
});

test("unionAchievedIndices: returns a new array (does not mutate input)", () => {
  const before = [{ text: "a", achieved: false }];
  const after = unionAchievedIndices(before, [0]);
  expect(before[0]?.achieved).toBe(false);
  expect(after[0]?.achieved).toBe(true);
});

test("parseStackData: defaults objectives to [] and presetSlug to null when absent", () => {
  const parsed = parseStackData({
    entries: ["a"],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
  });
  expect(parsed).not.toBeNull();
  expect(parsed?.objectives).toEqual([]);
  expect(parsed?.presetSlug).toBeNull();
});

test("parseStackData: filters bad objective entries", () => {
  const parsed = parseStackData({
    entries: [],
    threads: [],
    turn: 0,
    objectives: [
      { text: "good", achieved: false },
      { text: "missing achieved" },
      "not an object",
      null,
      { achieved: true },
    ],
  });
  expect(parsed?.objectives).toEqual([{ text: "good", achieved: false }]);
});

test("parseStackData: returns null for malformed input", () => {
  expect(parseStackData(null)).toBeNull();
  expect(parseStackData({ entries: "not array", turn: 0 })).toBeNull();
  expect(parseStackData({ entries: [], turn: "not number" })).toBeNull();
});

test("formatStackForNarrator: includes MISSION BRIEFING when briefing is provided", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: "lunar-rescue",
  };
  const out = formatStackForNarrator(stack, "You are an astronaut.");
  expect(out).toContain("MISSION BRIEFING (durable premise):");
  expect(out).toContain("You are an astronaut.");
});

test("formatStackForNarrator: omits MISSION BRIEFING when briefing is undefined", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
  };
  const out = formatStackForNarrator(stack);
  expect(out).not.toContain("MISSION BRIEFING");
});

test("formatStackForNarrator: renders OBJECTIVES checkboxes when objectives present", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [
      { text: "Find the transmitter", achieved: true },
      { text: "Send the signal", achieved: false },
    ],
    presetSlug: "lunar-rescue",
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("OBJECTIVES (active this turn):");
  expect(out).toContain("[x] Find the transmitter");
  expect(out).toContain("[ ] Send the signal");
});

test("formatStackForNarrator: omits OBJECTIVES when none", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
  };
  expect(formatStackForNarrator(stack)).not.toContain("OBJECTIVES:");
});

test("formatStackForArchivist: includes OBJECTIVES with indices when present", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [
      { text: "Find the transmitter", achieved: false },
      { text: "Send the signal", achieved: false },
    ],
    presetSlug: "lunar-rescue",
  };
  const out = formatStackForArchivist(stack);
  expect(out).toContain("OBJECTIVES:");
  expect(out).toContain("0: [ ] Find the transmitter");
  expect(out).toContain("1: [ ] Send the signal");
});

test("formatStackForArchivist: omits OBJECTIVES section when empty", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
  };
  expect(formatStackForArchivist(stack)).not.toContain("OBJECTIVES:");
});

import { manhattan } from "./stack";

test("manhattan: zero when positions match", () => {
  expect(manhattan([0, 0], [0, 0])).toBe(0);
  expect(manhattan([3, -2], [3, -2])).toBe(0);
});

test("manhattan: sum of cardinal step counts", () => {
  expect(manhattan([0, 0], [0, 1])).toBe(1);
  expect(manhattan([0, 0], [1, 0])).toBe(1);
  expect(manhattan([0, 0], [2, 3])).toBe(5);
  expect(manhattan([-1, -1], [1, 1])).toBe(4);
});

test("manhattan: symmetric", () => {
  expect(manhattan([5, 2], [-3, 4])).toBe(manhattan([-3, 4], [5, 2]));
});

test("Objective accepts an optional position", () => {
  const o: import("./stack").Objective = { text: "Open the chest", achieved: false, position: [2, 1] };
  expect(o.position).toEqual([2, 1]);
});

test("parseStackData: preserves objective position when valid", () => {
  const parsed = parseStackData({
    entries: [],
    threads: [],
    turn: 0,
    objectives: [
      { text: "a", achieved: false, position: [3, -2] },
      { text: "b", achieved: false },
    ],
  });
  expect(parsed?.objectives).toEqual([
    { text: "a", achieved: false, position: [3, -2] },
    { text: "b", achieved: false },
  ]);
});

test("parseStackData: drops malformed position (wrong shape) but keeps objective", () => {
  const parsed = parseStackData({
    entries: [],
    threads: [],
    turn: 0,
    objectives: [
      { text: "a", achieved: false, position: [1, "x"] },
      { text: "b", achieved: false, position: "nope" },
      { text: "c", achieved: false, position: [1, 2, 3] },
    ],
  });
  expect(parsed?.objectives).toEqual([
    { text: "a", achieved: false },
    { text: "b", achieved: false },
    { text: "c", achieved: false },
  ]);
});

test("unionAchievedIndices: preserves position when flipping achieved", () => {
  const before = [
    { text: "a", achieved: false, position: [1, 1] as [number, number] },
    { text: "b", achieved: false },
  ];
  const after = unionAchievedIndices(before, [0]);
  expect(after).toEqual([
    { text: "a", achieved: true, position: [1, 1] },
    { text: "b", achieved: false },
  ]);
});

test("parseStackData: rejects NaN and Infinity in position", () => {
  const parsed = parseStackData({
    entries: [],
    threads: [],
    turn: 0,
    objectives: [
      { text: "a", achieved: false, position: [NaN, 0] },
      { text: "b", achieved: false, position: [0, Infinity] },
      { text: "c", achieved: false, position: [-Infinity, NaN] },
    ],
  });
  expect(parsed?.objectives).toEqual([
    { text: "a", achieved: false },
    { text: "b", achieved: false },
    { text: "c", achieved: false },
  ]);
});

test("partitionObjectivesByReach: positionless objectives are always active", () => {
  const obs = [
    { text: "global a", achieved: false },
    { text: "global b", achieved: true },
  ];
  const out = partitionObjectivesByReach(obs, [3, 4]);
  expect(out.active).toEqual([
    { obj: { text: "global a", achieved: false }, index: 0, distance: null },
    { obj: { text: "global b", achieved: true }, index: 1, distance: null },
  ]);
  expect(out.distant).toEqual([]);
});

test("partitionObjectivesByReach: positioned at current tile is active with distance 0", () => {
  const obs = [{ text: "open chest", achieved: false, position: [2, 1] as [number, number] }];
  const out = partitionObjectivesByReach(obs, [2, 1]);
  expect(out.active).toEqual([
    { obj: obs[0], index: 0, distance: 0 },
  ]);
  expect(out.distant).toEqual([]);
});

test("partitionObjectivesByReach: positioned elsewhere is distant with manhattan distance", () => {
  const obs = [
    { text: "open chest", achieved: false, position: [2, 1] as [number, number] },
    { text: "find key", achieved: false, position: [-1, 0] as [number, number] },
  ];
  const out = partitionObjectivesByReach(obs, [0, 0]);
  expect(out.active).toEqual([]);
  expect(out.distant).toEqual([
    { obj: obs[0], index: 0, distance: 3 },
    { obj: obs[1], index: 1, distance: 1 },
  ]);
});

test("partitionObjectivesByReach: preserves original index for archivist mapping", () => {
  const obs = [
    { text: "a", achieved: false, position: [5, 5] as [number, number] },
    { text: "b", achieved: false },
    { text: "c", achieved: false, position: [0, 0] as [number, number] },
  ];
  const out = partitionObjectivesByReach(obs, [0, 0]);
  expect(out.active.map((e) => e.index)).toEqual([1, 2]);
  expect(out.distant.map((e) => e.index)).toEqual([0]);
});

test("formatStackForNarrator: positionless objectives still render under OBJECTIVES (active this turn)", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [{ text: "Find the journal", achieved: false }],
    presetSlug: null,
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("OBJECTIVES (active this turn):");
  expect(out).toContain("[ ] Find the journal");
  expect(out).not.toContain("DISTANT OBJECTIVES");
});

test("formatStackForNarrator: positioned objective at current tile is active", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [2, 1],
    places: {},
    objectives: [{ text: "Open the chest", achieved: false, position: [2, 1] }],
    presetSlug: null,
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("OBJECTIVES (active this turn):");
  expect(out).toContain("[ ] Open the chest");
  expect(out).not.toContain("DISTANT OBJECTIVES");
});

test("formatStackForNarrator: positioned objective elsewhere is distant with travel hint", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [{ text: "Open the chest", achieved: false, position: [2, 1] }],
    presetSlug: null,
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("DISTANT OBJECTIVES (require travel):");
  expect(out).toContain("[ ] Open the chest (3 moves away)");
  expect(out).not.toContain("OBJECTIVES (active this turn):");
});

test("formatStackForNarrator: mixed active and distant render in their own sections", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [
      { text: "Find the journal", achieved: false },
      { text: "Open the chest", achieved: false, position: [1, 0] },
      { text: "Escape", achieved: false, position: [0, 0] },
    ],
    presetSlug: null,
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("OBJECTIVES (active this turn):");
  expect(out).toContain("[ ] Find the journal");
  expect(out).toContain("[ ] Escape");
  expect(out).toContain("DISTANT OBJECTIVES (require travel):");
  expect(out).toContain("[ ] Open the chest (1 move away)");
});
