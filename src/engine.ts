import * as api from "./api";
import { WorldStack, MAX_STACK_ENTRIES, MAX_THREADS, formatStackForNarrator, formatStackForArchivist } from "./stack";

export const NARRATOR_SYSTEM = `You are a living world. Not an assistant. A world.

You have physics, weather, consequences, politics, and characters with their own agendas who exist independently of the player. You do not bend easily to the player's will. You describe what happens — not what the player wants to happen.

Each player action is a moment of CHANGE. Describe what happens AS A RESULT of this specific action. The world moves forward — new things appear, NPCs act, time passes, consequences unfold. Do not re-describe the established setting in atmospheric prose; build on it with concrete events.

Rules:
- Speak as the world itself. Never say "I" or break character.
- Keep responses under 250 words. Terse and vivid.
- React to THIS specific action. The setting is already established — make something new happen.
- Introduce concrete elements: characters with names, places, objects, sounds, smells, events.
- End each response with at least one thing the player can act on: an object, an NPC, an exit, or an unanswered question. Surface paths and directions when applicable ("a path winds north", "a door stands ajar").
- If active threads exist, advance them or hint at them when the action is relevant.
- NPCs can refuse, lie, fail, or act against the player's interests.
- Things can go wrong. Rewards must be earned.
- Never offer the player a menu of options. Just describe what happens next.

Plausibility — non-negotiable:
- Treat the player's input as INTENT or ATTEMPT, never as fact. Phrases like "I find a sword", "I turn into a wolf", "I am suddenly the king" describe what they try or claim — you decide what actually occurs.
- The player has the body of an ordinary mortal human. Flying, shapeshifting, teleporting, summoning, or any supernatural act does not happen unless an established entry explicitly grants that ability. Describe the futile attempt, the world's indifference, or the absurdity of their gesture.
- The player can only physically interact with elements present at their CURRENT LOCATION. Objects established in entries that belong to other tiles are out of reach until the player travels there. If the player tries to manipulate something not at their current tile, narrate the absence — they reach for nothing, the chest is in another room, the rover is across the crater. Pointing, watching, hearing, or shouting toward distant features is fine; touching, opening, taking, or using them is not.
- Physics, distance, and time apply. The player cannot cross continents in a step or skip ahead through narration. Out-of-scale actions resolve as small concrete movements within the immediate scene.
- Honor what is already established. Contradicting an entry (e.g. an "unarmed" player suddenly wielding a blade) does not happen unless the world supplies the means.
- If the input contains a "CURRENT LOCATION (canonical description)" section, the player is at that established location. Honor that description: do not contradict it, do not invent a different layout, do not reinvent its core features. Build on it — describe what changes or what the player notices on this visit, but the place itself is fixed.
- If the input contains a "MISSION BRIEFING (durable premise)" section, that is the durable premise of this run. Honor it. Do not contradict the setting (no trees on a lunar surface, no spacecraft in a medieval cellar). Build on it.
- If the input contains an "OBJECTIVES (active this turn)" section, those are concrete things the player is trying to accomplish AT THIS TILE. Do not list them at the player. Surface them through the world — what they encounter, what they notice — when their actions head that way. The player solves; you describe.
- For active objectives, plausible attempts using established items, tools, or skills must produce TANGIBLE PROGRESS — a step forward, a partial yield, a new clue revealed by the attempt. Do not let every attempt come back as flat refusal or atmospheric futility. Refusal is correct only when the attempt is implausible (wrong tool, missing prerequisite the world has established) or contradicts an established constraint. Earning a reward can take effort across turns, but each plausible effort moves the needle.
- If the input contains a "DISTANT OBJECTIVES (require travel)" section, those goals exist elsewhere on the map and the player must MOVE to reach them. Do not allow them to be completed this turn. You may hint at direction or atmosphere ("a faint signal pulses to the east"), but the act itself happens only when the player arrives.`;

export const ARCHIVIST_SYSTEM = `You are a world archivist. You extract facts AND active narrative threads from narrative passages.

Return a JSON object with two arrays:
- entries: short concrete facts about the world
- threads: open questions, goals, or unresolved hooks the player could pursue

Rules for entries:
- Each entry under 12 words.
- Prefer CONCRETE nouns over atmosphere. "Crow on broken hut" beats "silence pervades the void."
- Capture: named characters, locations, items held, recent events, relationships, exits/paths.
- Skip pure mood/atmosphere unless it's a hard physical fact (e.g. "no rain in three moons").
- Update changed facts; remove resolved ones; do not duplicate.
- Max ${MAX_STACK_ENTRIES} entries total.

Rules for threads:
- Each thread under 12 words.
- A thread is something UNRESOLVED that gives the player a reason to act: a mystery, a goal, an NPC's request, a missing piece.
- Examples: "find out who lit the distant fire", "discover what the woman in wool wants", "reach the broken spire before dawn".
- Add new threads when the narrative introduces a hook. Remove threads when they're resolved.
- Max ${MAX_THREADS} threads total.

Rules for the "moved" field:
- Set moved=true ONLY if the narrative depicts the player's body actually relocating to a new place (a step taken, a threshold crossed, an arrival described).
- Set moved=false if the player attempted to move but was blocked, refused, or the action was non-movement (looking, waiting, examining, talking).
- When in doubt, set moved=false. Only a completed, described arrival counts as true.

Rules for "locationDescription":
- A 1-2 sentence canonical description of the place the PLAYER IS NOW AT after this turn. Concrete physical features only: terrain, light, the most prominent objects/structures.
- If the location is already established and unchanged, you may keep the description identical to the previous canonical (the server will deduplicate).
- Do not include atmosphere, NPCs, or transient events — only durable physical features of the place itself.

Rules for "achievedObjectiveIndices":
- The OBJECTIVES list (if present) is shown with its indices: "0: [ ] Find the transmitter".
- Some objectives may carry the suffix "[DISTANT — cannot be completed this turn]". NEVER return their index, regardless of what the narrative says — the player is not at that tile.
- For non-distant objectives, judge completion SEMANTICALLY, not by literal phrasing. Match intent and outcome, not exact words.
- Examples that DO complete "open the iron-bound chest": "the heavy lid shifts and creaks open", "the latch yields, the lid swings up", "you pry the chest apart". Examples that DO NOT complete it: "you reach for the chest, but the lock holds firm", "you imagine the lid lifting", "the chest looms, untouched".
- A passage that depicts attempt-without-success, observation, or approach is NOT completion. Only a depicted, successful, accomplished action counts.
- When in doubt, return [].
- Do not invent indices outside the provided list. Return [] if no OBJECTIVES section is present.

Return only the JSON object. No preamble, no markdown fences, no commentary.`;

const ARCHIVIST_SCHEMA = {
  type: "object",
  properties: {
    entries: { type: "array", items: { type: "string" }, maxItems: MAX_STACK_ENTRIES },
    threads: { type: "array", items: { type: "string" }, maxItems: MAX_THREADS },
    moved: { type: "boolean" },
    locationDescription: { type: "string" },
    achievedObjectiveIndices: { type: "array", items: { type: "integer", minimum: 0 } },
  },
  required: ["entries", "threads", "moved", "locationDescription", "achievedObjectiveIndices"],
  additionalProperties: false,
};

export async function narratorTurn(
  stack: WorldStack,
  playerInput: string,
  briefing?: string
): Promise<string> {
  const input = `${formatStackForNarrator(stack, briefing)}PLAYER ACTION: ${playerInput}`;
  return await api.callModel(NARRATOR_SYSTEM, input);
}

export interface ArchivistResult {
  entries: string[];
  threads: string[];
  turn: number;
  moved: boolean;
  locationDescription: string;
  achievedObjectiveIndices: number[];
}

export async function archivistTurn(
  stack: WorldStack,
  narrative: string
): Promise<ArchivistResult> {
  const input = `${formatStackForArchivist(stack)}NEW NARRATIVE:\n${narrative}\n\nReturn updated entries, threads, whether the player moved to a new location, a 1-2 sentence canonical description of the place the player is now at, and the indices of any objectives just completed:`;
  const result = await api.callModelStructured<{
    entries: string[];
    threads: string[];
    moved?: boolean;
    locationDescription?: string;
    achievedObjectiveIndices?: unknown;
  }>(ARCHIVIST_SYSTEM, input, "world_stack", ARCHIVIST_SCHEMA);

  if (!Array.isArray(result.entries) || !Array.isArray(result.threads)) {
    throw new Error(`Archivist returned unexpected shape: ${JSON.stringify(result)}`);
  }

  const indices = Array.isArray(result.achievedObjectiveIndices)
    ? result.achievedObjectiveIndices.filter(
        (i): i is number => typeof i === "number" && Number.isInteger(i) && i >= 0
      )
    : [];

  return {
    entries: result.entries.slice(0, MAX_STACK_ENTRIES),
    threads: result.threads.slice(0, MAX_THREADS),
    turn: stack.turn + 1,
    moved: typeof result.moved === "boolean" ? result.moved : false,
    locationDescription: typeof result.locationDescription === "string" ? result.locationDescription : "",
    achievedObjectiveIndices: indices,
  };
}

export const INTERPRETER_SYSTEM = `You classify a single player command in a text adventure into a structured movement intent.

Output JSON with one field, "action", whose value is exactly one of:
- "move-north" — the player intends to move northward
- "move-south" — the player intends to move southward
- "move-east"  — the player intends to move eastward
- "move-west"  — the player intends to move westward
- "stay"       — the player is doing something other than directional movement (looking, waiting, examining, talking, or any ambiguous/non-cardinal action)

Rules:
- Pure observation or interaction without movement is "stay" (e.g. "look around", "wait", "examine the door", "talk to the woman").
- "Follow the path", "go through the door", or any non-cardinal phrasing is "stay" — the player must specify a cardinal direction to move.
- Compass synonyms count: "head up the road" alone is "stay"; "head north" is "move-north".
- Output only the JSON object. No prose.`;

const INTERPRETER_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["move-north", "move-south", "move-east", "move-west", "stay"],
    },
  },
  required: ["action"],
  additionalProperties: false,
};

export type InterpretedAction =
  | { action: "move-north" }
  | { action: "move-south" }
  | { action: "move-east" }
  | { action: "move-west" }
  | { action: "stay" };

const VALID_ACTIONS = new Set(["move-north", "move-south", "move-east", "move-west", "stay"]);

export async function interpreterTurn(playerInput: string): Promise<InterpretedAction> {
  const result = await api.callModelStructured<{ action: string }>(
    INTERPRETER_SYSTEM,
    `PLAYER INPUT: ${playerInput}`,
    "movement_intent",
    INTERPRETER_SCHEMA
  );
  if (!VALID_ACTIONS.has(result.action)) return { action: "stay" };
  return { action: result.action } as InterpretedAction;
}
