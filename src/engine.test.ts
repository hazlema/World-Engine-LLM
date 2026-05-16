import { test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as api from "./api";
import { narratorTurn, archivistTurn, interpreterTurn, NARRATOR_SYSTEM } from "./engine";
import { MAX_STACK_ENTRIES, MAX_THREADS } from "./stack";
import type { WorldStack } from "./stack";

let callModelSpy: any;
let callModelStructuredSpy: any;
let callInterpreterStructuredSpy: any;

const emptyStack: WorldStack = { entries: [], threads: [] as string[], turn: 0, position: [0, 0] as [number, number], places: {}, objectives: [], presetSlug: null, attributes: [], placeObjects: {} };
const populatedStack: WorldStack = {
  entries: [{ text: "world is cold" }, { text: "crow watches" }],
  threads: ["find the watcher"],
  turn: 2,
  position: [0, 0] as [number, number],
  places: {},
  objectives: [],
  presetSlug: null,
  attributes: [],
  placeObjects: {},
};

function makeStack(overrides: Partial<WorldStack> = {}): WorldStack {
  return {
    entries: [{ text: "a rusted key lies on the floor here" }],
    threads: [],
    turn: 1,
    position: [0, 0],
    places: { "0,0": "a stone cellar with damp walls" },
    objectives: [{ text: "Find the rusted key", achieved: false, position: [0, 0] }],
    presetSlug: null,
    attributes: [],
    placeObjects: {},
    ...overrides,
  };
}

beforeEach(() => {
  callModelSpy = spyOn(api, "callModel");
  callModelStructuredSpy = spyOn(api, "callModelStructured");
  callInterpreterStructuredSpy = spyOn(api, "callInterpreterStructured");
});

afterEach(() => {
  callModelSpy.mockRestore();
  callModelStructuredSpy.mockRestore();
  callInterpreterStructuredSpy.mockRestore();
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

test("archivistTurn: drops non-string entries (defensive filter for LLMs that put RoomObjects into entries[])", async () => {
  callModelStructuredSpy.mockImplementationOnce(async () => ({
    entries: [
      "a real fact",
      { name: "candle", states: ["lit"], category: "fixture" } as unknown as string, // LLM mis-emission
      "another real fact",
      null as unknown as string,
      "",
    ],
    threads: ["valid thread", null as unknown as string, ""],
  }));
  const result = await archivistTurn(emptyStack, "narrative");
  expect(result.entries).toEqual(["a real fact", "another real fact"]);
  expect(result.threads).toEqual(["valid thread"]);
});

test("interpreterTurn: classifies 'go north' as move-north", async () => {
  callInterpreterStructuredSpy.mockImplementationOnce(async () => ({ action: "move-north" }));
  const result = await interpreterTurn("go north");
  expect(result).toEqual({ action: "move-north" });
});

test("interpreterTurn: classifies 'look around' as stay", async () => {
  callInterpreterStructuredSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  const result = await interpreterTurn("look around");
  expect(result).toEqual({ action: "stay" });
});

test("interpreterTurn: passes the player input to the structured call", async () => {
  callInterpreterStructuredSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  await interpreterTurn("head west toward the dunes");
  // 4th call arg is the schema; 2nd arg is the input
  expect(callInterpreterStructuredSpy.mock.calls[0][1]).toContain("head west toward the dunes");
});

test("interpreterTurn: defaults to stay when API returns an unknown action", async () => {
  callInterpreterStructuredSpy.mockImplementationOnce(async () => ({ action: "invalid" as any }));
  const result = await interpreterTurn("?????");
  expect(result).toEqual({ action: "stay" });
});

test("NARRATOR_SYSTEM: instructs the narrator to honor a canonical location description", () => {
  expect(NARRATOR_SYSTEM).toContain("CURRENT LOCATION");
  expect(NARRATOR_SYSTEM.toLowerCase()).toMatch(/honor|consistent|do not contradict/);
});

test("NARRATOR_SYSTEM: cardinal moves are tile transitions, not in-scene steps", () => {
  // Surfaced via the user's Lunar Rescue demo run: position updated correctly
  // (interpreter authoritative) but the narrator kept describing the lander
  // cabin even at [2,0] — typing `north` from the cabin produced narrative
  // about walking around inside the cabin instead of crossing the EVA hatch
  // and arriving on the regolith.
  // The "Out-of-scale actions resolve as small concrete movements within the
  // immediate scene" rule (intended to stop "I walk to Tokyo") was misfiring
  // on legit cardinal moves. Need to explicitly carve out cardinals as TILE
  // TRANSITIONS.
  const lower = NARRATOR_SYSTEM.toLowerCase();
  expect(lower).toMatch(/tile transition|new tile|leaving the (current|previous) (location|tile)/);
  // Reinforce: the move is NOT continued presence in the prior setting.
  expect(lower).toMatch(/threshold|arrival|leave the.{0,40}entire|leaving the/);
});

test("NARRATOR_SYSTEM: names established items when surfacing them", () => {
  // Observed 2026-05-10: narrator described the transmitter at distance as
  // "something half-buried in the regolith" and "a metallic glint" without
  // ever using the noun "transmitter". Player tried `look at transmitter` and
  // the model couldn't connect, said "transmitter isn't here." The fix is to
  // require established items be named when surfaced, so the player can
  // reference them back. Atmospheric texture is still fine alongside the name.
  const lower = NARRATOR_SYSTEM.toLowerCase();
  expect(lower).toMatch(/canonical noun|use its name when|vague descriptors alone/);
});

test("NARRATOR_SYSTEM: forbids preemptive denial of present items", () => {
  // Observed 2026-05-10: player typed `north` and arrived at the transmitter's
  // tile; narrator said "no sign of a transmitter" (then on next `look around`
  // the narrator found it). The active-objective-binds rule forbids
  // SUBSTITUTING the named item with an alternative, but didn't explicitly
  // forbid DENYING its presence. Substitution-by-negation. Tighten to
  // explicitly prohibit phrases like "no transmitter here" / "no sign of X"
  // when X is at the player's current tile.
  const lower = NARRATOR_SYSTEM.toLowerCase();
  expect(lower).toMatch(/preemptively deny|do not.{0,40}deny presence|substitution.by.negation|no sign of/);
});

test("NARRATOR_SYSTEM: binds active-objective items to the current tile", () => {
  // Observed in playlog 2026-05-10T19:37+: active objective "Find the
  // transmitter" at [1,0] plus established entry "damaged transmitter
  // half-buried in regolith" — but the narrator described a "metallic glint"
  // that, on examination, resolved to "a torn sheet of aluminum" and a
  // mysterious boot print. The transmitter was substituted out. The model
  // treated objective and established-entry as independent facts.
  // Rule must force the bind: when an active-objective item is in entries,
  // the narrative at this tile must reference THAT named item, not a
  // substitute.
  const lower = NARRATOR_SYSTEM.toLowerCase();
  // Distinctive language not present in the existing tangible-progress rule.
  expect(lower).toMatch(/do not substitute|substitute alternative|substitute a different/);
});

test("NARRATOR_SYSTEM: forbids retcon via offscreen backstory invention", () => {
  // Surfaced via Opus's Cellar of Glass run: turn 24 placed an iron key in a
  // depression beneath a flagstone (canonized in entries). Turn 25 narrated
  // "the iron key is not here. You recall leaving it on the table in the
  // alchemist's study, upstairs" — there is no alchemist's study. The model
  // invented offscreen backstory to delete an established item.
  // The existing "Honor what is already established... unless the world
  // supplies the means" rule is too loose; the model interpreted "you remember
  // leaving it upstairs" as the world supplying the means.
  const lower = NARRATOR_SYSTEM.toLowerCase();
  // Explicit anti-retcon language.
  expect(lower).toMatch(/retcon|invent.{0,30}backstory|invent.{0,30}offscreen/);
  // The rule must specify items leave only via depicted on-screen change.
  expect(lower).toMatch(/on.?screen|depicted.{0,40}this turn/);
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
    attributes: [],
    placeObjects: {},
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
    attributes: [],
    placeObjects: {},
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
    attributes: [],
    placeObjects: {},
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

test("ARCHIVIST_SYSTEM: distinguishes atmospheric clues from completion", async () => {
  const { ARCHIVIST_SYSTEM } = await import("./engine");
  // The prompt must explicitly call out atmospheric clues as non-completion,
  // not just observation/approach. Surfacing a clue is what the narrator does;
  // the archivist must not treat it as resolution.
  expect(ARCHIVIST_SYSTEM.toLowerCase()).toContain("atmospheric clue");
});

test("ARCHIVIST_SYSTEM: has explicit rule for discovery objectives", async () => {
  const { ARCHIVIST_SYSTEM } = await import("./engine");
  // Discovery objectives ("find out X", "identify Y", "learn Z", "discover W")
  // need their own rule because the physical-action examples don't generalize.
  // The rule must require the player to actively gain the knowledge in the
  // CURRENT turn's narrative, not derive it from the established stack alone.
  const lower = ARCHIVIST_SYSTEM.toLowerCase();
  expect(lower).toContain("discovery");
  expect(lower).toContain("identify");
  // The "this turn" framing is what blocks cumulative-stack reasoning.
  expect(lower).toMatch(/this turn|this narrative/);
});

test("ARCHIVIST_SYSTEM: absence from narrative does not invalidate established entries", async () => {
  // Observed via Opus 2026-05-10: established-items list oscillating
  // wildly across consecutive turns (11 → 13 → 4 → 13 → 6 → 13 → 6 → 9).
  // The model was treating "not mentioned this turn" as "should be removed",
  // then re-canonizing entries the next turn. Need an explicit rule that
  // absence is not invalidation — preserve entries unless explicitly
  // contradicted, superseded, or consumed.
  const { ARCHIVIST_SYSTEM } = await import("./engine");
  const lower = ARCHIVIST_SYSTEM.toLowerCase();
  expect(lower).toMatch(/absence.{0,40}not.{0,40}invalidat|preserve.{0,80}current stack|do not drop.{0,40}absent|not mentioned/);
});

test("ARCHIVIST_SYSTEM: has supersession rule for state changes", async () => {
  const { ARCHIVIST_SYSTEM } = await import("./engine");
  // The archivist must REPLACE old entries when an item is taken, placed,
  // or otherwise has its state changed — not accumulate "rose on flagstones"
  // alongside "rose in player's hand". Same for count/quantity changes
  // (three candles → two).
  const lower = ARCHIVIST_SYSTEM.toLowerCase();
  expect(lower).toMatch(/supersede|replace the old|replace.*entry/);
  // The rule must give an example covering both an item move and a count change.
  expect(lower).toMatch(/take|taken|picked up|player's hand/);
  expect(lower).toMatch(/three.*candles|count|quantity/);
});

test("ARCHIVIST_SYSTEM: explicitly skips transient sensory details from entries", async () => {
  const { ARCHIVIST_SYSTEM } = await import("./engine");
  // Momentary atmosphere ("draft pulls at your cloak", "dripping quickens",
  // "darkness deepens") shouldn't be canonized in entries — only durable
  // physical facts. The existing "skip mood/atmosphere" rule isn't strong
  // enough; we need the entries section to call out sensory specifically
  // with a concrete example. Note "transient" alone matches the existing
  // locationDescription rule, so we look for "sensory" which is novel.
  const lower = ARCHIVIST_SYSTEM.toLowerCase();
  expect(lower).toContain("sensory");
});

test("ARCHIVIST_SYSTEM: LOCATE excludes action verbs (send/restore/repair)", async () => {
  // Observed via Opus 2026-05-10: "Send the distress signal @ 1,0" fired
  // when player typed `north` and arrived at [1,0] — without depicting any
  // signal being sent. The LOCATE override ("observation at the target tile
  // IS completion") was being applied to all objectives at the target tile,
  // including PHYSICAL ACTION objectives. The LOCATE rule must explicitly
  // exclude action verbs.
  const { ARCHIVIST_SYSTEM } = await import("./engine");
  const lower = ARCHIVIST_SYSTEM.toLowerCase();
  // Must list exclusion verbs explicitly.
  expect(lower).toMatch(/send.{0,40}restore|send the distress|action verbs/);
  expect(lower).toMatch(/locate.{0,80}only.{0,80}find|find.{0,30}locate.{0,30}reach.{0,80}not/);
});

test("ARCHIVIST_SYSTEM: LOCATE rule carves out the observation-no-completion rule", async () => {
  // Observed 2026-05-10 (post-LOCATE-fix run): player at [1,0] where the
  // transmitter is established + narrative named the transmitter on arrival,
  // but `Find the transmitter` did not fire. The general not-completion rule
  // ("observation, approach, atmospheric clue is NOT completion") conflicted
  // with the LOCATE rule, and the model deferred to the conservative reading.
  // Need an explicit carve-out: for LOCATE, observation AT the target tile
  // IS the completion event.
  const { ARCHIVIST_SYSTEM } = await import("./engine");
  const lower = ARCHIVIST_SYSTEM.toLowerCase();
  expect(lower).toMatch(/does not apply to locate|locating is.{0,40}completion|locate.{0,40}exception|observation at the target/);
});

test("ARCHIVIST_SYSTEM: has rule for LOCATE objectives (find/locate/reach a place)", async () => {
  // Plain "Find the transmitter @ 1,0" objectives fell through both prior
  // rules: not a discovery (find out / identify), not a physical state-change
  // (open / break). The not-completion catchall (observation / approach) was
  // blocking the model from firing on a legit arrival+naming. Need a third
  // category that fires when the player is at the coordinate AND the narrative
  // names the target.
  const { ARCHIVIST_SYSTEM } = await import("./engine");
  const lower = ARCHIVIST_SYSTEM.toLowerCase();
  expect(lower).toContain("locate objective");
  // Must explicitly include "find" / "locate" / "reach" as the trigger shapes.
  expect(lower).toMatch(/"find"|"locate"|"reach"|find x|locate y|reach z/);
  // Worked example anchoring with an actual preset objective.
  expect(lower).toMatch(/transmitter|the target tile|the player is at the/);
});

test("ARCHIVIST_SYSTEM: distinguishes static state-description from state-change", async () => {
  const { ARCHIVIST_SYSTEM } = await import("./engine");
  // Physical-action objectives need the NARRATIVE to depict the change
  // happening this turn (the lid shifting, the latch yielding) — not merely
  // describe a post-state ("the chest gapes open"). Otherwise a `look
  // around` where the narrator hallucinates an opened chest fires the
  // "Open the iron-bound chest" objective. We need explicit language and
  // a worked DO-NOT example using static state phrasing.
  const lower = ARCHIVIST_SYSTEM.toLowerCase();
  expect(lower).toMatch(/state.change|state-change|change.{0,40}occurring|depict.{0,40}change/);
  expect(lower).toMatch(/gapes open|state.description|static.state/);
});

test("interpreterTurn: classifies bare cardinal as move", async () => {
  callInterpreterStructuredSpy.mockImplementationOnce(async () => ({ action: "move-north" }));
  const result = await interpreterTurn("north");
  expect(result).toEqual({ action: "move-north" });
});

test("interpreterTurn: classifies non-movement as stay", async () => {
  callInterpreterStructuredSpy.mockImplementationOnce(async () => ({ action: "stay" }));
  const result = await interpreterTurn("examine the door");
  expect(result).toEqual({ action: "stay" });
});

test("interpreterTurn: classifies movement-without-cardinal as move-blocked", async () => {
  callInterpreterStructuredSpy.mockImplementationOnce(async () => ({ action: "move-blocked" }));
  const result = await interpreterTurn("go to the train");
  expect(result).toEqual({ action: "move-blocked" });
});

// SNAPSHOT_FIXTURES tests

test("SNAPSHOT_FIXTURES off → no fixture file written", async () => {
  const prev = process.env.SNAPSHOT_FIXTURES;
  delete process.env.SNAPSHOT_FIXTURES;
  callModelSpy.mockImplementationOnce(async () => "narration text");
  try {
    await narratorTurn(makeStack(), "look");
  } finally {
    if (prev !== undefined) process.env.SNAPSHOT_FIXTURES = prev;
  }
  expect(callModelSpy).toHaveBeenCalledTimes(1);
});

test("SNAPSHOT_FIXTURES on → narrator + archivist rows appended", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snap-"));
  const fixturePath = join(dir, "out.jsonl");
  process.env.SNAPSHOT_FIXTURES = fixturePath;
  callModelSpy.mockImplementationOnce(async () => "you find a rusted key on the floor.");
  callModelStructuredSpy.mockImplementationOnce(async () => ({
    entries: ["the rusted key is in the player's hand"],
    threads: [],
    moved: false,
    locationDescription: "a stone cellar",
    achievedObjectiveIndices: [0],
  }));
  try {
    const stack = makeStack();
    const narrative = await narratorTurn(stack, "look");
    await archivistTurn(stack, narrative);
  } finally {
    delete process.env.SNAPSHOT_FIXTURES;
  }
  const text = await Bun.file(fixturePath).text();
  const lines = text.trim().split("\n").filter((l) => l.length > 0);
  expect(lines.length).toBe(2);
  const narratorRow = JSON.parse(lines[0]);
  const archivistRow = JSON.parse(lines[1]);
  expect(narratorRow.stage).toBe("narrator");
  expect(narratorRow.snapshotId).toMatch(/^t\d+$/);
  expect(narratorRow.narrator.userMessage).toContain("PLAYER ACTION: look");
  expect(narratorRow.narrator.userMessage).toContain("rusted key");
  expect(narratorRow.narrator.mustNameTarget).toBe("key");
  expect(archivistRow.stage).toBe("archivist");
  expect(archivistRow.archivist.userMessage).toContain("NEW NARRATIVE:");
  expect(archivistRow.archivist.narrativePassage).toContain("rusted key");
  expect(archivistRow.archivist.objectiveCount).toBe(1);
  await rm(dir, { recursive: true });
});

test("narratorTurn: includes PLAYER ATTRIBUTES section in user message when stack has attributes", async () => {
  let capturedInput = "";
  callModelSpy.mockImplementationOnce(async (_sys: string, inp: string) => {
    capturedInput = inp;
    return "Something happens.";
  });
  const stack: WorldStack = {
    ...emptyStack,
    attributes: [{ name: "magic", scope: ["can manipulate objects"] }],
  };
  await narratorTurn(stack, "raise the candlestick with magic");
  expect(capturedInput).toContain("PLAYER ATTRIBUTES (immutable):");
  expect(capturedInput).toContain("- magic");
  expect(capturedInput).toContain("  - can manipulate objects");
});

test("archivistTurn: includes PLAYER ATTRIBUTES section in user message when stack has attributes", async () => {
  let capturedInput = "";
  callModelStructuredSpy.mockImplementationOnce(async (_sys: string, inp: string) => {
    capturedInput = inp;
    return { entries: [], threads: [], moved: false, locationDescription: "", achievedObjectiveIndices: [] };
  });
  const stack: WorldStack = {
    ...emptyStack,
    attributes: [{ name: "wizard", scope: ["can read minds"] }],
  };
  await archivistTurn(stack, "the candle gutters");
  expect(capturedInput).toContain("PLAYER ATTRIBUTES (immutable):");
  expect(capturedInput).toContain("- wizard");
  expect(capturedInput).toContain("  - can read minds");
});

test("NARRATOR_SYSTEM: honors PLAYER ATTRIBUTES when present, denies absent abilities", () => {
  expect(NARRATOR_SYSTEM).toContain("PLAYER ATTRIBUTES (immutable)");
  const lower = NARRATOR_SYSTEM.toLowerCase();
  expect(lower).toMatch(/absence is denial/);
  expect(lower).toMatch(/sub-bullets scope/);
  expect(lower).toMatch(/ordinary mortal human/);
});

test("ARCHIVIST_SYSTEM: forbids paraphrasing player attributes as world entries", async () => {
  const { ARCHIVIST_SYSTEM } = await import("./engine");
  expect(ARCHIVIST_SYSTEM).toContain("PLAYER ATTRIBUTES (immutable)");
  const lower = ARCHIVIST_SYSTEM.toLowerCase();
  expect(lower).toMatch(/immutable session data/);
  expect(lower).toMatch(/do not add entries.*paraphrase|paraphrase.*restate/);
});

test("archivistTurn: returns objects parsed from model response", async () => {
  callModelStructuredSpy.mockResolvedValue({
    entries: ["a candle on a desk"],
    threads: [],
    moved: false,
    locationDescription: "a small study with an oak desk",
    achievedObjectiveIndices: [],
    objects: [
      { name: "candle", states: ["lit"], location: "on oak desk", category: "fixture" },
      { name: "key", states: ["worn smooth"], category: "item" },
    ],
  });
  const result = await archivistTurn(makeStack(), "narrative text");
  expect(result.objects).toEqual([
    { name: "candle", states: ["lit"], location: "on oak desk", category: "fixture" },
    { name: "key", states: ["worn smooth"], category: "item" },
  ]);
});

test("archivistTurn: defaults objects to empty array when missing", async () => {
  callModelStructuredSpy.mockResolvedValue({
    entries: [],
    threads: [],
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [],
    // no `objects` field at all
  });
  const result = await archivistTurn(makeStack(), "narrative text");
  expect(result.objects).toEqual([]);
});

test("archivistTurn: filters invalid objects (bad category, missing name)", async () => {
  callModelStructuredSpy.mockResolvedValue({
    entries: [],
    threads: [],
    moved: false,
    locationDescription: "",
    achievedObjectiveIndices: [],
    objects: [
      { name: "good", states: [], category: "fixture" },
      { name: "", states: [], category: "fixture" }, // empty name — drop
      { name: "bad-cat", states: [], category: "player_body" }, // not in enum — drop
      { name: "no-cat", states: [] }, // missing category — drop
    ],
  });
  const result = await archivistTurn(makeStack(), "narrative text");
  expect(result.objects.map((o) => o.name)).toEqual(["good"]);
});
