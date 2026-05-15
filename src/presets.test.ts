import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePresetText, presetSlugFromPath, loadAllPresets } from "./presets";

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
    { text: "Find the transmitter" },
    { text: "Send the distress signal" },
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

test("parsePresetText: parses positioned objective '@ x,y' suffix", () => {
  const text = `---
title: T
description: D
objects:
  - a
objectives:
  - Open the chest @ 2,1
  - Find the journal @ -1,3
  - Escape the cellar
---
body`;
  const p = parsePresetText(text, "x");
  expect(p.objectives).toEqual([
    { text: "Open the chest", position: [2, 1] },
    { text: "Find the journal", position: [-1, 3] },
    { text: "Escape the cellar" },
  ]);
});

test("parsePresetText: '@' inside the text without a coord pair is left alone", () => {
  const text = `---
title: T
description: D
objects:
  - a
objectives:
  - Email the curator @ midnight
---
body`;
  const p = parsePresetText(text, "x");
  expect(p.objectives).toEqual([
    { text: "Email the curator @ midnight" },
  ]);
});

test("parsePresetText: tolerates whitespace around the coord pair", () => {
  const text = `---
title: T
description: D
objects:
  - a
objectives:
  - Find the key @  4 , -2
---
body`;
  const p = parsePresetText(text, "x");
  expect(p.objectives).toEqual([
    { text: "Find the key", position: [4, -2] },
  ]);
});

test("parsePresetText: bare '@ x,y' with no descriptive text is left as raw text", () => {
  const text = `---
title: T
description: D
objects:
  - a
objectives:
  - @ 1,2
---
body`;
  const p = parsePresetText(text, "x");
  expect(p.objectives).toEqual([{ text: "@ 1,2" }]);
});

test("parsePresetText: parses attributes with hierarchical bullets", () => {
  const text = `---
title: T
description: D
attributes:
  - normal human abilities
    - cannot lie
  - tattoo of a dove on left shoulder
  - magic
    - can manipulate objects
    - cannot manipulate time
objects:
  - oak staff
objectives:
  - do something
---
body`;
  const p = parsePresetText(text, "x");
  expect(p.attributes).toEqual([
    { name: "normal human abilities", scope: ["cannot lie"] },
    { name: "tattoo of a dove on left shoulder", scope: [] },
    { name: "magic", scope: ["can manipulate objects", "cannot manipulate time"] },
  ]);
});

test("parsePresetText: missing attributes field defaults to []", () => {
  const text = `---
title: T
description: D
objects:
  - a
objectives:
  - o
---
body`;
  const p = parsePresetText(text, "x");
  expect(p.attributes).toEqual([]);
});

test("parsePresetText: empty attributes header defaults to []", () => {
  const text = `---
title: T
description: D
attributes:
objects:
  - a
objectives:
  - o
---
body`;
  const p = parsePresetText(text, "x");
  expect(p.attributes).toEqual([]);
});

test("parsePresetText: bare top-level attribute has empty scope", () => {
  const text = `---
title: T
description: D
attributes:
  - red hair
objects:
  - a
objectives:
  - o
---
body`;
  const p = parsePresetText(text, "x");
  expect(p.attributes).toEqual([{ name: "red hair", scope: [] }]);
});

test("parsePresetText: throws when sub-bullet appears under objects:", () => {
  const text = `---
title: T
description: D
objects:
  - candle
    - melted
objectives:
  - o
---
body`;
  expect(() => parsePresetText(text, "x")).toThrow(/sub-bullet/);
});

test("parsePresetText: throws when sub-bullet appears under objectives:", () => {
  const text = `---
title: T
description: D
objects:
  - a
objectives:
  - find it
    - in the corner
---
body`;
  expect(() => parsePresetText(text, "x")).toThrow(/sub-bullet/);
});

test("parsePresetText: throws when sub-bullet appears with no parent attribute", () => {
  const text = `---
title: T
description: D
attributes:
    - orphan sub-bullet
objects:
  - a
objectives:
  - o
---
body`;
  expect(() => parsePresetText(text, "x")).toThrow(/sub-bullet/);
});

test("parsePresetText: throws when an attribute name exceeds 80 chars", () => {
  const longName = "x".repeat(81);
  const text = `---
title: T
description: D
attributes:
  - ${longName}
objects:
  - a
objectives:
  - o
---
body`;
  expect(() => parsePresetText(text, "x")).toThrow(/80/);
});

test("parsePresetText: throws when an attribute has more than 10 sub-bullets", () => {
  const subs = Array.from({ length: 11 }, (_, i) => `    - sub ${i}`).join("\n");
  const text = `---
title: T
description: D
attributes:
  - magic
${subs}
objects:
  - a
objectives:
  - o
---
body`;
  expect(() => parsePresetText(text, "x")).toThrow(/10 sub-bullets/);
});

test("parsePresetText: throws on empty attribute name (whitespace-only bullet)", () => {
  // "  -   " (dash followed by spaces, content trimmable to "") matches the
  // listItem regex but trips the empty-bullet guard. The pattern
  // distinguishes "empty content" from "malformed line" (the latter would be
  // e.g. a 3-space indent, which falls through to the catch-all throw).
  const text = "---\ntitle: T\ndescription: D\nattributes:\n  -   \nobjects:\n  - a\nobjectives:\n  - o\n---\nbody";
  expect(() => parsePresetText(text, "x")).toThrow(/empty bullet/);
});

test("parsePresetText: accepts exactly 10 sub-bullets per attribute", () => {
  const subs = Array.from({ length: 10 }, (_, i) => `    - sub ${i}`).join("\n");
  const text = `---
title: T
description: D
attributes:
  - magic
${subs}
objects:
  - a
objectives:
  - o
---
body`;
  const p = parsePresetText(text, "x");
  expect(p.attributes[0]?.scope).toHaveLength(10);
});

const MIN_PRESET = `---
title: T
description: D
objects:
  - thing
objectives:
  - do thing
---
body`;

test("loadAllPresets: stores bannerPath when matching .png exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "presets-"));
  try {
    await writeFile(join(dir, "alpha.md"), MIN_PRESET);
    await writeFile(join(dir, "alpha.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const presets = await loadAllPresets(dir);
    expect(presets.get("alpha")?.bannerPath).toBe(join(dir, "alpha.png"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadAllPresets: prefers .png over .jpg over .webp", async () => {
  const dir = await mkdtemp(join(tmpdir(), "presets-"));
  try {
    await writeFile(join(dir, "alpha.md"), MIN_PRESET);
    await writeFile(join(dir, "alpha.webp"), Buffer.from([0x52, 0x49, 0x46, 0x46]));
    await writeFile(join(dir, "alpha.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    await writeFile(join(dir, "alpha.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const presets = await loadAllPresets(dir);
    expect(presets.get("alpha")?.bannerPath).toBe(join(dir, "alpha.png"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadAllPresets: leaves bannerPath undefined when no image", async () => {
  const dir = await mkdtemp(join(tmpdir(), "presets-"));
  try {
    await writeFile(join(dir, "alpha.md"), MIN_PRESET);
    const presets = await loadAllPresets(dir);
    expect(presets.get("alpha")?.bannerPath).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadAllPresets: falls back to .jpg when .png missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "presets-"));
  try {
    await writeFile(join(dir, "alpha.md"), MIN_PRESET);
    await writeFile(join(dir, "alpha.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    const presets = await loadAllPresets(dir);
    expect(presets.get("alpha")?.bannerPath).toBe(join(dir, "alpha.jpg"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
