import { test, expect } from "bun:test";
import { parsePresetText, presetSlugFromPath } from "./presets";

const SAMPLE = `---
title: Lunar Rescue
description: Stranded on the far side. Send the signal.
objects:
  - damaged transmitter half-buried in regolith
  - oxygen cache strapped to the lander hull
objectives:
  - Find the transmitter
  - Send the distress signal
---
You are an astronaut stranded on the lunar far side.
Your suit is functional.`;

test("parsePresetText: extracts title, description, objects, objectives, body", () => {
  const p = parsePresetText(SAMPLE, "lunar-rescue");
  expect(p.slug).toBe("lunar-rescue");
  expect(p.title).toBe("Lunar Rescue");
  expect(p.description).toBe("Stranded on the far side. Send the signal.");
  expect(p.objects).toEqual([
    "damaged transmitter half-buried in regolith",
    "oxygen cache strapped to the lander hull",
  ]);
  expect(p.objectives).toEqual([
    "Find the transmitter",
    "Send the distress signal",
  ]);
  expect(p.body).toBe(
    "You are an astronaut stranded on the lunar far side.\nYour suit is functional."
  );
});

test("parsePresetText: throws when frontmatter delimiters are missing", () => {
  expect(() => parsePresetText("no frontmatter here", "x")).toThrow(/frontmatter/);
});

test("parsePresetText: throws when a required field is missing", () => {
  const missingObjectives = `---
title: T
description: D
objects:
  - a
---
body`;
  expect(() => parsePresetText(missingObjectives, "x")).toThrow(/objectives/);
});

test("parsePresetText: throws when title is empty", () => {
  const empty = `---
title:
description: D
objects:
  - a
objectives:
  - o
---
body`;
  expect(() => parsePresetText(empty, "x")).toThrow(/title/);
});

test("parsePresetText: throws when a list field is empty", () => {
  const empty = `---
title: T
description: D
objects:
objectives:
  - o
---
body`;
  expect(() => parsePresetText(empty, "x")).toThrow(/objects/);
});

test("presetSlugFromPath: derives slug from a presets/*.md path", () => {
  expect(presetSlugFromPath("presets/lunar-rescue.md")).toBe("lunar-rescue");
  expect(presetSlugFromPath("./presets/the-last-train.md")).toBe("the-last-train");
});
