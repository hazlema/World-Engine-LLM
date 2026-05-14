import { test, expect, describe } from "bun:test";
import { buildImagePrompt, DEFAULT_IMAGE_STYLE } from "./gemini-image";
import type { PlayerAttribute } from "./presets";

describe("buildImagePrompt", () => {
  test("with no playerAttributes: omits the Player character details block", () => {
    const prompt = buildImagePrompt("A scene unfolds.", DEFAULT_IMAGE_STYLE);
    expect(prompt).not.toContain("Player character details");
    expect(prompt).toContain("Scene:");
    expect(prompt).toContain("A scene unfolds.");
  });

  test("with empty playerAttributes array: omits the Player character details block", () => {
    const prompt = buildImagePrompt("A scene unfolds.", DEFAULT_IMAGE_STYLE, []);
    expect(prompt).not.toContain("Player character details");
  });

  test("with populated playerAttributes: includes the block before Scene", () => {
    const attrs: PlayerAttribute[] = [
      { name: "striking auburn hair in a ponytail", scope: [] },
      { name: "tattoo of a dove on left shoulder", scope: [] },
      { name: "magic", scope: ["can manipulate objects"] },
    ];
    const prompt = buildImagePrompt("She raises her hand; the lock clicks.", DEFAULT_IMAGE_STYLE, attrs);
    const detailsIdx = prompt.indexOf("Player character details (apply only if the player figure appears in frame):");
    const sceneIdx = prompt.indexOf("Scene:");
    expect(detailsIdx).toBeGreaterThanOrEqual(0);
    expect(sceneIdx).toBeGreaterThan(detailsIdx);
    expect(prompt).toContain("- striking auburn hair in a ponytail");
    expect(prompt).toContain("- tattoo of a dove on left shoulder");
    expect(prompt).toContain("- magic");
    expect(prompt).toContain("  - can manipulate objects");
  });

  test("preserves the existing 'Render this scene as a cinematic 21:9 ultrawide image.' opener", () => {
    const prompt = buildImagePrompt("X.", DEFAULT_IMAGE_STYLE);
    expect(prompt.startsWith("Render this scene as a cinematic 21:9 ultrawide image.")).toBe(true);
  });

  test("preserves the 'No text, captions, or watermarks.' rule", () => {
    const prompt = buildImagePrompt("X.", DEFAULT_IMAGE_STYLE);
    expect(prompt).toContain("No text, captions, or watermarks.");
  });
});
