import { test, expect } from "bun:test";
import { formatStackForNarrator, formatStackForArchivist, posKey, applyDirection, applyPresetToStack, unionAchievedIndices, parseStackData, manhattan, partitionObjectivesByReach, locateObjectiveAnchor, extractPinnedNames, applyRoomObjectsSafetyNet, tagEntriesByTile, CATEGORY_PRIORITY, MAX_PLACE_OBJECTS, type Objective, type WorldStack, type RoomObject, type ObjectCategory } from "./stack";
import type { Preset, PlayerAttribute } from "./presets";

test("formatStackForNarrator: empty stack returns empty string", () => {
  expect(formatStackForNarrator({ entries: [], threads: [], turn: 0, position: [0, 0] as [number, number], places: {}, objectives: [], presetSlug: null, attributes: [], placeObjects: {} })).toBe("");
});

test("formatStackForNarrator: entries only", () => {
  const stack = { entries: [{ text: "world is cold" }, { text: "crow watches" }], threads: [], turn: 1, position: [0, 0] as [number, number], places: {}, objectives: [], presetSlug: null, attributes: [], placeObjects: {} };
  expect(formatStackForNarrator(stack)).toBe(
    "ESTABLISHED WORLD:\n- world is cold\n- crow watches\n\n"
  );
});

test("formatStackForNarrator: threads only", () => {
  const stack = { entries: [], threads: ["find the missing watcher"], turn: 1, position: [0, 0] as [number, number], places: {}, objectives: [], presetSlug: null, attributes: [], placeObjects: {} };
  expect(formatStackForNarrator(stack)).toBe(
    "ACTIVE THREADS:\n- find the missing watcher\n\n"
  );
});

test("formatStackForNarrator: entries and threads together", () => {
  const stack = {
    entries: [{ text: "world is cold" }],
    threads: ["find the watcher"],
    turn: 1,
    position: [0, 0] as [number, number],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  expect(formatStackForNarrator(stack)).toBe(
    "ESTABLISHED WORLD:\n- world is cold\n\nACTIVE THREADS:\n- find the watcher\n\n"
  );
});

test("formatStackForArchivist: empty stack returns empty headers for both", () => {
  expect(formatStackForArchivist({ entries: [], threads: [], turn: 0, position: [0, 0] as [number, number], places: {}, objectives: [], presetSlug: null, attributes: [], placeObjects: {} })).toBe(
    "CURRENT STACK: (empty)\n\nACTIVE THREADS: (none)\n\n"
  );
});

test("formatStackForArchivist: populated stack", () => {
  const stack = {
    entries: [{ text: "world is cold" }],
    threads: ["find the watcher"],
    turn: 2,
    position: [0, 0] as [number, number],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  expect(formatStackForArchivist(stack)).toBe(
    "CURRENT STACK:\n- world is cold\n\nACTIVE THREADS:\n- find the watcher\n\nMUST INCLUDE: watcher\n\n"
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
    attributes: [],
    placeObjects: {},
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
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForNarrator(stack);
  expect(out).not.toContain("CURRENT LOCATION (canonical description):");
});

test("formatStackForNarrator: includes ROOM STATE block with objects", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {
      "0,0": [
        { name: "candle", states: ["lit"], location: "on oak desk", category: "fixture" },
        { name: "key", states: ["worn smooth"], category: "item" },
      ],
    },
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("ROOM STATE:");
  expect(out).toContain("- candle: lit (on oak desk)");
  expect(out).toContain("- key: worn smooth");
});

test("formatStackForNarrator: omits ROOM STATE block when current tile has none", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {
      // Different tile has objects, but current tile [0,0] does not.
      "1,0": [{ name: "candle", states: ["lit"], category: "fixture" }],
    },
  };
  const out = formatStackForNarrator(stack);
  expect(out).not.toContain("ROOM STATE");
});

test("formatStackForNarrator: object with no states omits trailing colon", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {
      "0,0": [{ name: "oak desk", states: [], category: "feature" }],
    },
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("- oak desk");
  expect(out).not.toContain("- oak desk: ");
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
  attributes: [],
  body: "You are an astronaut.",
};

test("applyPresetToStack: seeds entries from objects (world-scope: no tile), objectives from objectives, sets slug", () => {
  const s = applyPresetToStack(samplePreset);
  expect(s.entries).toEqual([{ text: "damaged transmitter" }, { text: "oxygen cache" }]);
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
    attributes: [],
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
    attributes: [],
    placeObjects: {},
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
    attributes: [],
    placeObjects: {},
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
    attributes: [],
    placeObjects: {},
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
    attributes: [],
    placeObjects: {},
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
    attributes: [],
    placeObjects: {},
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
    attributes: [],
    placeObjects: {},
  };
  expect(formatStackForArchivist(stack)).not.toContain("OBJECTIVES:");
});

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
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("OBJECTIVES (active this turn):");
  expect(out).toContain("[ ] Find the journal");
  expect(out).not.toContain("OFF-TILE OBJECTIVES");
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
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("OBJECTIVES (active this turn):");
  expect(out).toContain("[ ] Open the chest");
  expect(out).not.toContain("OFF-TILE OBJECTIVES");
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
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("OFF-TILE OBJECTIVES (require travel):");
  expect(out).toContain("[ ] Open the chest (3 moves: 2 north, 1 east)");
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
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("OBJECTIVES (active this turn):");
  expect(out).toContain("[ ] Find the journal");
  expect(out).toContain("[ ] Escape");
  expect(out).toContain("OFF-TILE OBJECTIVES (require travel):");
  expect(out).toContain("[ ] Open the chest (1 move north)");
});

test("formatStackForNarrator: distant objectives include cardinal direction in hint", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [
      { text: "Find the journal", achieved: false, position: [-1, 0] },
      { text: "Reach the well", achieved: false, position: [0, -2] },
      { text: "Climb the spire", achieved: false, position: [3, 0] },
      { text: "Cross the bridge", achieved: false, position: [0, 1] },
    ],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("[ ] Find the journal (1 move south)");
  expect(out).toContain("[ ] Reach the well (2 moves west)");
  expect(out).toContain("[ ] Climb the spire (3 moves north)");
  expect(out).toContain("[ ] Cross the bridge (1 move east)");
});

test("formatStackForArchivist: positionless objective shows no flag", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [{ text: "Find the journal", achieved: false }],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForArchivist(stack);
  expect(out).toContain("0: [ ] Find the journal");
  expect(out).not.toContain("[OFF-TILE");
});

test("formatStackForArchivist: positioned-at-current-tile objective shows no flag", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [2, 1],
    places: {},
    objectives: [{ text: "Open the chest", achieved: false, position: [2, 1] }],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForArchivist(stack);
  expect(out).toContain("0: [ ] Open the chest");
  expect(out).not.toContain("[OFF-TILE");
});

test("formatStackForArchivist: positioned-elsewhere objective is flagged [OFF-TILE — cannot be completed this turn]", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [
      { text: "Open the chest", achieved: false, position: [2, 1] },
      { text: "Find the journal", achieved: false },
    ],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForArchivist(stack);
  expect(out).toContain("0: [ ] Open the chest [OFF-TILE — cannot be completed this turn]");
  expect(out).toContain("1: [ ] Find the journal");
});

// locateObjectiveAnchor tests

test("locateObjectiveAnchor: extracts trailing noun from 'Find the rusted key'", () => {
  expect(locateObjectiveAnchor("Find the rusted key")).toBe("key");
});

test("locateObjectiveAnchor: extracts trailing noun from 'Locate the broken lantern'", () => {
  expect(locateObjectiveAnchor("Locate the broken lantern")).toBe("lantern");
});

test("locateObjectiveAnchor: extracts trailing noun from 'Discover the location of the iron chest'", () => {
  expect(locateObjectiveAnchor("Discover the location of the iron chest")).toBe("chest");
});

test("locateObjectiveAnchor: returns null for non-LOCATE input", () => {
  expect(locateObjectiveAnchor("go north")).toBeNull();
});

test("locateObjectiveAnchor: returns null for bare 'Find' with no target", () => {
  expect(locateObjectiveAnchor("Find")).toBeNull();
});

test("locateObjectiveAnchor: handles 'Reach the broken spire'", () => {
  expect(locateObjectiveAnchor("Reach the broken spire")).toBe("spire");
});

test("applyPresetToStack: copies preset.attributes onto the new stack", () => {
  const preset: Preset = {
    slug: "test",
    title: "T",
    description: "D",
    objects: [],
    objectives: [],
    attributes: [
      { name: "magic", scope: ["can manipulate objects"] },
      { name: "red hair", scope: [] },
    ],
    body: "body",
  };
  const stack = applyPresetToStack(preset);
  expect(stack.attributes).toEqual([
    { name: "magic", scope: ["can manipulate objects"] },
    { name: "red hair", scope: [] },
  ]);
});

test("parseStackData: preserves attributes through JSON round-trip", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [{ name: "magic", scope: ["can manipulate objects"] }],
    placeObjects: {},
  };
  const json = JSON.stringify(stack);
  const reparsed = parseStackData(JSON.parse(json));
  expect(reparsed?.attributes).toEqual([{ name: "magic", scope: ["can manipulate objects"] }]);
});

test("parseStackData: defaults attributes to [] when field is missing (old stack file)", () => {
  const oldShape = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    // no attributes field
  };
  const parsed = parseStackData(oldShape);
  expect(parsed?.attributes).toEqual([]);
});

test("parseStackData: defaults attributes to [] when field is malformed", () => {
  const badShape = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: "not an array",
  };
  const parsed = parseStackData(badShape);
  expect(parsed?.attributes).toEqual([]);
});

test("parseStackData: drops individual attribute when its scope contains a non-string element, keeps others", () => {
  // The every() filter is item-level, not element-level: a bad scope
  // element drops the whole attribute (defensive, predictable). This test
  // pins that behavior so a future change to filter element-by-element
  // shows up as a deliberate break.
  const shape = {
    entries: [], threads: [], turn: 0, position: [0, 0], places: {}, objectives: [], presetSlug: null,
    attributes: [
      { name: "magic", scope: ["can manipulate objects", 42, "also valid"] },
      { name: "red hair", scope: [] },
    ],
  };
  const parsed = parseStackData(shape);
  expect(parsed?.attributes).toEqual([{ name: "red hair", scope: [] }]);
});

test("applyPresetToStack: attributes scope arrays are reference-isolated from the preset", () => {
  const preset: Preset = {
    slug: "x", title: "T", description: "D", objects: [], objectives: [],
    attributes: [{ name: "magic", scope: ["can do thing"] }],
    body: "b",
  };
  const stack = applyPresetToStack(preset);
  // Mutating the stack's scope must not affect the preset's scope.
  stack.attributes[0]!.scope.push("MUTATED");
  expect(preset.attributes[0]!.scope).toEqual(["can do thing"]);
});

test("formatStackForNarrator: includes PLAYER ATTRIBUTES as the first section when populated", () => {
  const stack: WorldStack = {
    entries: ["dusty bookshelf"],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [
      { name: "magic", scope: ["can manipulate objects", "cannot manipulate time"] },
      { name: "red hair", scope: [] },
    ],
    placeObjects: {},
  };
  const out = formatStackForNarrator(stack, "you wake in a study");
  // Section appears first.
  const attrIdx = out.indexOf("PLAYER ATTRIBUTES (immutable):");
  const briefingIdx = out.indexOf("MISSION BRIEFING");
  expect(attrIdx).toBeGreaterThanOrEqual(0);
  expect(briefingIdx).toBeGreaterThan(attrIdx);
  // Format check: top-level dash, sub-bullet 2-space indent.
  expect(out).toContain("- magic");
  expect(out).toContain("  - can manipulate objects");
  expect(out).toContain("  - cannot manipulate time");
  expect(out).toContain("- red hair");
});

test("formatStackForNarrator: omits PLAYER ATTRIBUTES section when empty", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForNarrator(stack, "premise");
  expect(out).not.toContain("PLAYER ATTRIBUTES");
});

test("formatStackForArchivist: includes PLAYER ATTRIBUTES as the first section when populated", () => {
  const stack: WorldStack = {
    entries: ["a key on the table"],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [{ name: "wizard", scope: ["can read minds"] }],
    placeObjects: {},
  };
  const out = formatStackForArchivist(stack);
  expect(out).toContain("PLAYER ATTRIBUTES (immutable):");
  expect(out).toContain("- wizard");
  expect(out).toContain("  - can read minds");
  // Section appears first — before CURRENT STACK and ACTIVE THREADS.
  const attrIdx = out.indexOf("PLAYER ATTRIBUTES (immutable):");
  const stackIdx = out.indexOf("CURRENT STACK:");
  expect(attrIdx).toBeGreaterThanOrEqual(0);
  expect(stackIdx).toBeGreaterThan(attrIdx);
});

test("formatStackForArchivist: omits PLAYER ATTRIBUTES section when empty", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForArchivist(stack);
  expect(out).not.toContain("PLAYER ATTRIBUTES");
});

test("parseStackData: missing placeObjects defaults to empty object", () => {
  const raw = {
    entries: ["a"],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
  };
  const parsed = parseStackData(raw);
  expect(parsed?.placeObjects).toEqual({});
});

test("parseStackData: preserves valid placeObjects", () => {
  const raw = {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {
      "0,0": [
        { name: "candle", states: ["lit"], location: "on desk", category: "fixture" },
      ],
    },
  };
  const parsed = parseStackData(raw);
  expect(parsed?.placeObjects["0,0"]?.[0]?.name).toBe("candle");
  expect(parsed?.placeObjects["0,0"]?.[0]?.states).toEqual(["lit"]);
  expect(parsed?.placeObjects["0,0"]?.[0]?.category).toBe("fixture");
});

test("extractPinnedNames: pulls anchor nouns from active LOCATE objectives", () => {
  const objectives: Objective[] = [
    { text: "Find the brass key", achieved: false },
    { text: "Locate the wooden rose", achieved: false },
    { text: "Open the iron chest", achieved: false },
  ];
  const names = extractPinnedNames(objectives, []);
  expect(names).toContain("key");
  expect(names).toContain("rose");
});

test("extractPinnedNames: skips achieved objectives", () => {
  const objectives: Objective[] = [
    { text: "Find the brass key", achieved: true },
    { text: "Locate the wooden rose", achieved: false },
  ];
  const names = extractPinnedNames(objectives, []);
  expect(names).not.toContain("key");
  expect(names).toContain("rose");
});

test("extractPinnedNames: pulls trailing nouns from threads as cheap heuristic", () => {
  const names = extractPinnedNames([], ["find out who lit the distant fire", "discover the brass altar"]);
  // last word of each thread, length>2, lowercase
  expect(names).toContain("fire");
  expect(names).toContain("altar");
});

test("extractPinnedNames: returns empty set when nothing to pin", () => {
  expect(extractPinnedNames([], [])).toEqual(new Set());
});

test("safetyNet: drops player-self-referential objects", () => {
  const archivistObjects: RoomObject[] = [
    { name: "your hair", states: ["red"], category: "feature" },
    { name: "the player's eyes", states: ["alert"], category: "feature" },
    { name: "Player's shadow", states: ["long"], category: "feature" },
    { name: "candle", states: ["lit"], category: "fixture" },
  ];
  const result = applyRoomObjectsSafetyNet(archivistObjects, [], new Set());
  expect(result.map((o) => o.name)).toEqual(["candle"]);
});

test("safetyNet: pinned-name 'chest' does NOT double-add when archivist already emitted 'apprentice's chest'", () => {
  // Regression for the Merlin's Daughter session that produced the visible
  // duplicate in placeObjects[0,0]. Pinned names use fuzzy .includes() match
  // for restoration; the presence check must use the SAME semantics so
  // "apprentice's chest" satisfies a pin on "chest".
  const prior: RoomObject[] = [
    { name: "apprentice's chest", states: ["brass-bound"], location: "on the desk", category: "fixture" },
    { name: "candle", states: ["snuffed"], category: "fixture" },
  ];
  const archivistObjects: RoomObject[] = [
    { name: "apprentice's chest", states: ["brass-bound"], location: "on the desk", category: "fixture" },
    { name: "candle", states: ["snuffed"], category: "fixture" },
    { name: "quill", states: [], location: "on the desk", category: "item" },
  ];
  // Pinned names mirror what extractPinnedNames produces from objective
  // "Open the apprentice's chest" — trailing-noun anchor "chest".
  const result = applyRoomObjectsSafetyNet(archivistObjects, prior, new Set(["chest"]));
  const chestCount = result.filter((o) => o.name === "apprentice's chest").length;
  expect(chestCount).toBe(1);
  expect(result.map((o) => o.name).sort()).toEqual(["apprentice's chest", "candle", "quill"]);
});

test("safetyNet: pinned-name still triggers restoration when archivist genuinely dropped the object", () => {
  // Make sure the fuzzy presence check didn't accidentally disable
  // restoration for the case it was designed for.
  const prior: RoomObject[] = [
    { name: "iron key", states: ["worn smooth"], category: "item" },
  ];
  const archivistObjects: RoomObject[] = [
    { name: "candle", states: ["lit"], category: "fixture" },
  ];
  const result = applyRoomObjectsSafetyNet(archivistObjects, prior, new Set(["key"]));
  expect(result.map((o) => o.name).sort()).toEqual(["candle", "iron key"]);
});

test("safetyNet: de-dupes objects emitted twice by the archivist in a single turn (keep first)", () => {
  const archivistObjects: RoomObject[] = [
    { name: "apprentice's chest", states: ["brass-bound"], location: "on the desk", category: "fixture" },
    { name: "candle", states: ["snuffed"], category: "fixture" },
    { name: "Apprentice's Chest", states: ["brass-bound"], location: "on the desk", category: "fixture" }, // duplicate, different case
    { name: "apprentice's chest", states: ["brass-bound", "later-restatement"], category: "fixture" }, // duplicate, slightly different states
  ];
  const result = applyRoomObjectsSafetyNet(archivistObjects, [], new Set());
  expect(result.map((o) => o.name)).toEqual(["apprentice's chest", "candle"]);
  // First occurrence wins, including its states.
  const chest = result.find((o) => o.name === "apprentice's chest");
  expect(chest?.states).toEqual(["brass-bound"]);
});

test("safetyNet: restores missing pinned object from prior state", () => {
  const prior: RoomObject[] = [
    { name: "candle", states: ["lit"], location: "on oak desk", category: "fixture" },
    { name: "key", states: ["worn smooth"], category: "item" },
  ];
  const archivistObjects: RoomObject[] = [
    { name: "candle", states: ["lit"], location: "on oak desk", category: "fixture" },
    // archivist dropped "key" by mistake — should be restored
  ];
  const pinned = new Set(["key"]);
  const result = applyRoomObjectsSafetyNet(archivistObjects, prior, pinned);
  expect(result.map((o) => o.name).sort()).toEqual(["candle", "key"]);
  const restored = result.find((o) => o.name === "key");
  expect(restored?.states).toEqual(["worn smooth"]);
});

test("safetyNet: does not invent objects not in prior state", () => {
  const prior: RoomObject[] = [];
  const archivistObjects: RoomObject[] = [];
  const pinned = new Set(["unicorn"]);
  const result = applyRoomObjectsSafetyNet(archivistObjects, prior, pinned);
  expect(result).toEqual([]);
});

test("safetyNet: cap enforcement drops feature before fixture before item", () => {
  const archivistObjects: RoomObject[] = [
    { name: "item-1", states: [], category: "item" },
    { name: "item-2", states: [], category: "item" },
    { name: "item-3", states: [], category: "item" },
    { name: "fix-1", states: [], category: "fixture" },
    { name: "fix-2", states: [], category: "fixture" },
    { name: "fix-3", states: [], category: "fixture" },
    { name: "feat-1", states: [], category: "feature" },
    { name: "feat-2", states: [], category: "feature" },
    { name: "feat-3", states: [], category: "feature" },
    { name: "feat-4", states: [], category: "feature" },
    { name: "feat-5", states: [], category: "feature" },
  ];
  const result = applyRoomObjectsSafetyNet(archivistObjects, [], new Set());
  expect(result.length).toBe(MAX_PLACE_OBJECTS);
  // No features should survive when 6 normals/highs exist
  const remaining = result.map((o) => o.category);
  const featureCount = remaining.filter((c) => c === "feature").length;
  expect(featureCount).toBeLessThanOrEqual(MAX_PLACE_OBJECTS - 6);
});

test("safetyNet: pinned name forces high priority and survives cap", () => {
  // 10 features + 1 pinned feature; the pinned one must survive.
  const features: RoomObject[] = Array.from({ length: 10 }, (_, i) => ({
    name: `feat-${i}`,
    states: [],
    category: "feature" as ObjectCategory,
  }));
  const pinnedFeature: RoomObject = {
    name: "candle",
    states: ["lit"],
    category: "feature",
  };
  const result = applyRoomObjectsSafetyNet(
    [...features, pinnedFeature],
    [],
    new Set(["candle"])
  );
  expect(result.length).toBe(MAX_PLACE_OBJECTS);
  expect(result.some((o) => o.name === "candle")).toBe(true);
});

test("safetyNet: within a tier, prefers keeping objects whose state changed this turn", () => {
  const prior: RoomObject[] = [
    { name: "lever", states: ["up"], category: "fixture" },
    { name: "hatch", states: ["closed"], category: "fixture" },
  ];
  // Eleven fixtures, two of which appear in prior. Of the two in prior, only
  // "hatch" has a state change ("closed" → "open"). Cap drops one — should
  // prefer dropping the unchanged "lever" over the changed "hatch".
  const archivistObjects: RoomObject[] = [
    { name: "lever", states: ["up"], category: "fixture" },          // unchanged
    { name: "hatch", states: ["open"], category: "fixture" },        // changed
    ...Array.from({ length: 9 }, (_, i) => ({
      name: `fix-new-${i}`,
      states: [] as string[],
      category: "fixture" as ObjectCategory,
    })),
  ];
  const result = applyRoomObjectsSafetyNet(archivistObjects, prior, new Set());
  expect(result.length).toBe(MAX_PLACE_OBJECTS);
  // The changed one must survive.
  expect(result.some((o) => o.name === "hatch")).toBe(true);
  // The unchanged one is the only natural drop candidate.
  expect(result.some((o) => o.name === "lever")).toBe(false);
});

test("formatStackForArchivist: includes CURRENT TILE OBJECTS when current tile has prior objects", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {
      "0,0": [
        { name: "candle", states: ["lit"], location: "on desk", category: "fixture" },
        { name: "key", states: ["worn smooth"], category: "item" },
      ],
    },
  };
  const out = formatStackForArchivist(stack);
  expect(out).toContain("CURRENT TILE OBJECTS:");
  expect(out).toContain("- candle (fixture, on desk): lit");
  expect(out).toContain("- key (item): worn smooth");
});

test("formatStackForArchivist: omits CURRENT TILE OBJECTS when current tile has none", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForArchivist(stack);
  expect(out).not.toContain("CURRENT TILE OBJECTS");
});

test("formatStackForArchivist: includes MUST INCLUDE when pinned names exist", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [
      { text: "Find the brass key", achieved: false, position: [0, 0] },
    ],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForArchivist(stack);
  expect(out).toContain("MUST INCLUDE: key");
});

test("formatStackForArchivist: omits MUST INCLUDE when no pinned names", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForArchivist(stack);
  expect(out).not.toContain("MUST INCLUDE");
});

test("formatStackForArchivist: object without states formats without colon-empty", () => {
  const stack: WorldStack = {
    entries: [],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {
      "0,0": [{ name: "wall", states: [], category: "feature" }],
    },
  };
  const out = formatStackForArchivist(stack);
  expect(out).toContain("- wall (feature)");
  expect(out).not.toContain("- wall (feature): ");
});

// Entry tile-scoping — the leak fix.

test("formatStackForNarrator: world-scope entries (no tile) appear at every tile", () => {
  const stack: WorldStack = {
    entries: [{ text: "no rain in three moons" }, { text: "the king is dead" }],
    threads: [],
    turn: 0,
    position: [3, 5],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("- no rain in three moons");
  expect(out).toContain("- the king is dead");
});

test("formatStackForNarrator: entries tagged to current tile are visible", () => {
  const stack: WorldStack = {
    entries: [{ text: "iron key on stone altar", tile: "1,0" }],
    threads: [],
    turn: 0,
    position: [1, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("- iron key on stone altar");
});

test("formatStackForNarrator: entries tagged to a DIFFERENT tile are filtered out", () => {
  const stack: WorldStack = {
    entries: [
      { text: "iron key on stone altar", tile: "0,0" },
      { text: "shattered window", tile: "5,5" },
    ],
    threads: [],
    turn: 0,
    position: [1, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForNarrator(stack);
  // The whole ESTABLISHED WORLD section should be absent when every entry is off-tile.
  expect(out).not.toContain("ESTABLISHED WORLD");
  expect(out).not.toContain("iron key");
  expect(out).not.toContain("shattered window");
});

test("formatStackForNarrator: mix of world-scope, current-tile, and off-tile renders only the first two", () => {
  const stack: WorldStack = {
    entries: [
      { text: "no rain in three moons" },                          // world-scope
      { text: "iron key on stone altar", tile: "1,0" },            // current tile
      { text: "rusted lever in the cellar", tile: "0,0" },         // off-tile (LEAK candidate)
    ],
    threads: [],
    turn: 0,
    position: [1, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForNarrator(stack);
  expect(out).toContain("- no rain in three moons");
  expect(out).toContain("- iron key on stone altar");
  expect(out).not.toContain("rusted lever");
});

test("formatStackForArchivist: shows ALL entries (full prior state) regardless of tile, text only", () => {
  const stack: WorldStack = {
    entries: [
      { text: "iron key on stone altar", tile: "0,0" },
      { text: "rusted lever in the cellar", tile: "5,5" },
      { text: "no rain in three moons" },
    ],
    threads: [],
    turn: 0,
    position: [1, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
  };
  const out = formatStackForArchivist(stack);
  expect(out).toContain("- iron key on stone altar");
  expect(out).toContain("- rusted lever in the cellar");
  expect(out).toContain("- no rain in three moons");
  // No tile tag leaks into the archivist's view — it sees text only.
  expect(out).not.toContain("0,0");
  expect(out).not.toContain("5,5");
});

// Parser — legacy strings + new object shape.

test("parseStackData: legacy string entries auto-migrate to world-scope (tile=undefined)", () => {
  const parsed = parseStackData({
    entries: ["alpha", "beta"],
    threads: [],
    turn: 0,
    position: [0, 0],
  });
  expect(parsed?.entries).toEqual([{ text: "alpha" }, { text: "beta" }]);
});

test("parseStackData: new shape preserves tile tags through round-trip", () => {
  const parsed = parseStackData({
    entries: [
      { text: "alpha", tile: "1,0" },
      { text: "beta" },
      { text: "gamma", tile: "-2,3" },
    ],
    threads: [],
    turn: 0,
    position: [0, 0],
  });
  expect(parsed?.entries).toEqual([
    { text: "alpha", tile: "1,0" },
    { text: "beta" },
    { text: "gamma", tile: "-2,3" },
  ]);
});

test("parseStackData: drops malformed entry items (non-string, non-{text})", () => {
  const parsed = parseStackData({
    entries: ["ok", { text: "fine", tile: "0,0" }, null, 42, { tile: "1,0" }, { text: 5 }],
    threads: [],
    turn: 0,
    position: [0, 0],
  });
  expect(parsed?.entries).toEqual([{ text: "ok" }, { text: "fine", tile: "0,0" }]);
});

test("parseStackData: empty string tile is treated as world-scope (no tile field)", () => {
  const parsed = parseStackData({
    entries: [{ text: "alpha", tile: "" }],
    threads: [],
    turn: 0,
    position: [0, 0],
  });
  expect(parsed?.entries).toEqual([{ text: "alpha" }]);
});

// tagEntriesByTile — server-side diff tagging.

test("tagEntriesByTile: brand-new entry is tagged with current tile", () => {
  const out = tagEntriesByTile(["alpha"], [], "1,0");
  expect(out).toEqual([{ text: "alpha", tile: "1,0" }]);
});

test("tagEntriesByTile: entry that matches prior text inherits prior's tile", () => {
  const prior = [{ text: "alpha", tile: "0,0" }];
  const out = tagEntriesByTile(["alpha"], prior, "1,0");
  expect(out).toEqual([{ text: "alpha", tile: "0,0" }]);
});

test("tagEntriesByTile: prior world-scope entry (no tile) stays world-scope on re-emission", () => {
  const prior = [{ text: "world fact" }];
  const out = tagEntriesByTile(["world fact"], prior, "1,0");
  expect(out).toEqual([{ text: "world fact" }]);
});

test("tagEntriesByTile: mixed prior + new — each tagged correctly", () => {
  const prior = [
    { text: "old fact a", tile: "0,0" },
    { text: "old fact b" },
  ];
  const out = tagEntriesByTile(["old fact a", "old fact b", "brand new"], prior, "2,3");
  expect(out).toEqual([
    { text: "old fact a", tile: "0,0" },
    { text: "old fact b" },
    { text: "brand new", tile: "2,3" },
  ]);
});

test("tagEntriesByTile: removed prior entries are not preserved", () => {
  const prior = [
    { text: "kept", tile: "0,0" },
    { text: "dropped", tile: "0,0" },
  ];
  const out = tagEntriesByTile(["kept"], prior, "1,0");
  expect(out).toEqual([{ text: "kept", tile: "0,0" }]);
});
