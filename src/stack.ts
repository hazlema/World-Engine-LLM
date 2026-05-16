import type { Preset, PlayerAttribute } from "./presets";

const STACK_FILE = new URL("../world-stack.json", import.meta.url).pathname;
export const MAX_STACK_ENTRIES = 25;
export const MAX_THREADS = 10;
export const MAX_PLACE_OBJECTS = 10;

export type ObjectCategory = "item" | "fixture" | "feature" | "character";

export interface RoomObject {
  name: string;
  states: string[];
  location?: string;
  category: ObjectCategory;
}

export const CATEGORY_PRIORITY: Record<ObjectCategory, "high" | "normal" | "low"> = {
  item: "high",
  character: "high",
  fixture: "normal",
  feature: "low",
};

export type Position = [number, number];
export type Direction = "north" | "south" | "east" | "west";

export interface Objective {
  text: string;
  achieved: boolean;
  position?: Position;
}

export interface WorldStack {
  entries: string[];
  threads: string[];
  turn: number;
  position: Position;
  places: Record<string, string>;
  objectives: Objective[];
  presetSlug: string | null;
  attributes: PlayerAttribute[];
}

// Coordinate convention: Position is [lat, lon] — north/south affect index 0,
// east/west affect index 1. North and east are positive. Preset coordinates
// (`@ x,y`) follow the same convention: the first number is north-south, the
// second is east-west. So `@ -1,0` is one tile south, `@ 0,1` is one tile east.
const DELTAS: Record<Direction, Position> = {
  north: [1, 0],
  south: [-1, 0],
  east: [0, 1],
  west: [0, -1],
};

export function posKey(p: Position): string {
  return `${p[0]},${p[1]}`;
}

export function manhattan(a: Position, b: Position): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

export function travelHint(from: Position, to: Position): string {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const total = Math.abs(dx) + Math.abs(dy);
  if (total === 0) return "here";
  const ns = dx > 0 ? `${dx} north` : dx < 0 ? `${-dx} south` : "";
  const ew = dy > 0 ? `${dy} east` : dy < 0 ? `${-dy} west` : "";
  if (!ns) return `${total} ${total === 1 ? "move" : "moves"} ${ew.split(" ")[1]}`;
  if (!ew) return `${total} ${total === 1 ? "move" : "moves"} ${ns.split(" ")[1]}`;
  return `${total} moves: ${ns}, ${ew}`;
}

export interface ReachEntry {
  obj: Objective;
  index: number;
  distance: number | null;
}

export function partitionObjectivesByReach(
  objectives: Objective[],
  here: Position
): { active: ReachEntry[]; distant: ReachEntry[] } {
  const active: ReachEntry[] = [];
  const distant: ReachEntry[] = [];
  objectives.forEach((obj, index) => {
    if (!obj.position) {
      active.push({ obj, index, distance: null });
      return;
    }
    const d = manhattan(here, obj.position);
    if (d === 0) {
      active.push({ obj, index, distance: 0 });
    } else {
      distant.push({ obj, index, distance: d });
    }
  });
  return { active, distant };
}

export function applyDirection(p: Position, dir: Direction): Position {
  const d = DELTAS[dir];
  return [p[0] + d[0], p[1] + d[1]];
}

function emptyStack(): WorldStack {
  return {
    entries: [],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: [],
    presetSlug: null,
    attributes: [],
  };
}

export function parseStackData(data: any): WorldStack | null {
  if (
    data === null ||
    typeof data !== "object" ||
    !Array.isArray(data.entries) ||
    typeof data.turn !== "number"
  ) {
    return null;
  }
  const position: Position =
    Array.isArray(data.position) &&
    data.position.length === 2 &&
    typeof data.position[0] === "number" &&
    typeof data.position[1] === "number"
      ? [data.position[0], data.position[1]]
      : [0, 0];
  const places: Record<string, string> =
    data.places !== null && typeof data.places === "object" && !Array.isArray(data.places)
      ? data.places
      : {};
  const objectives: Objective[] = Array.isArray(data.objectives)
    ? data.objectives
        .filter(
          (o: any) =>
            o &&
            typeof o === "object" &&
            typeof o.text === "string" &&
            typeof o.achieved === "boolean"
        )
        .map((o: any) => {
          const base: Objective = { text: o.text, achieved: o.achieved };
          if (
            Array.isArray(o.position) &&
            o.position.length === 2 &&
            typeof o.position[0] === "number" &&
            typeof o.position[1] === "number" &&
            Number.isFinite(o.position[0]) &&
            Number.isFinite(o.position[1])
          ) {
            base.position = [o.position[0], o.position[1]];
          }
          return base;
        })
    : [];
  const presetSlug: string | null =
    typeof data.presetSlug === "string" ? data.presetSlug : null;
  const attributes: PlayerAttribute[] = Array.isArray(data.attributes)
    ? data.attributes
        .filter(
          (a: any) =>
            a &&
            typeof a === "object" &&
            typeof a.name === "string" &&
            Array.isArray(a.scope) &&
            a.scope.every((s: any) => typeof s === "string")
        )
        .map((a: any) => ({ name: a.name, scope: [...a.scope] }))
    : [];

  return {
    entries: data.entries,
    threads: Array.isArray(data.threads) ? data.threads : [],
    turn: data.turn,
    position,
    places,
    objectives,
    presetSlug,
    attributes,
  };
}

export async function loadStack(): Promise<WorldStack> {
  const file = Bun.file(STACK_FILE);
  if (!(await file.exists())) return emptyStack();
  try {
    const data = await file.json();
    const parsed = parseStackData(data);
    if (parsed) return parsed;
    console.error("Stack file has unexpected shape, starting fresh.");
    return emptyStack();
  } catch {
    console.error("Corrupt stack file, starting fresh.");
    return emptyStack();
  }
}

export async function saveStack(stack: WorldStack): Promise<void> {
  try {
    await Bun.write(STACK_FILE, JSON.stringify(stack, null, 2));
  } catch (err) {
    console.error("Failed to save stack:", err);
    throw err;
  }
}

// Returns the lowercased trailing-noun anchor of a LOCATE-style objective text
// (Find / Locate / Reach / Discover the location of <the> ... <noun>), or null
// if the text doesn't match the pattern.
export function locateObjectiveAnchor(objectiveText: string): string | null {
  const m = objectiveText.match(/^(?:Find|Locate|Reach|Discover the location of)\s+(?:the\s+)?(.+)$/i);
  if (!m || !m[1]) return null;
  const words = m[1].trim().split(/\s+/).filter((w) => w.length > 2);
  const last = words[words.length - 1];
  if (!last) return null;
  return last.toLowerCase();
}

// Match LOCATE-style objectives ("Find the X", "Locate the X", "Reach the X",
// "Discover the location of X") against entries containing the target noun.
// Returns explicit per-turn naming directives so the narrator can't substitute
// a decoy item — the load-bearing rule for LOCATE objective completion.
function findTargetNamingHints(activeObjectives: Objective[], entries: string[]): string[] {
  const hints: string[] = [];
  for (const obj of activeObjectives) {
    if (obj.achieved) continue;
    const anchor = locateObjectiveAnchor(obj.text);
    if (!anchor) continue;
    const re = new RegExp(`\\b${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const match = entries.find((e) => re.test(e));
    if (match) hints.push(`- "${match}" (matches active objective: "${obj.text}")`);
  }
  return hints;
}

function formatPlayerAttributesBlock(attrs: PlayerAttribute[]): string | null {
  if (attrs.length === 0) return null;
  const lines: string[] = [];
  for (const a of attrs) {
    lines.push(`- ${a.name}`);
    for (const s of a.scope) {
      lines.push(`  - ${s}`);
    }
  }
  return `PLAYER ATTRIBUTES (immutable):\n${lines.join("\n")}`;
}

export function formatStackForNarrator(stack: WorldStack, briefing?: string): string {
  const parts: string[] = [];
  const attrBlock = formatPlayerAttributesBlock(stack.attributes);
  if (attrBlock) parts.push(attrBlock);
  if (briefing && briefing.trim().length > 0) {
    parts.push(`MISSION BRIEFING (durable premise):\n${briefing.trim()}`);
  }
  let activeObjs: Objective[] = [];
  if (stack.objectives.length > 0) {
    const { active, distant } = partitionObjectivesByReach(stack.objectives, stack.position);
    activeObjs = active.map(({ obj }) => obj);
    if (active.length > 0) {
      const lines = active.map(({ obj }) => `[${obj.achieved ? "x" : " "}] ${obj.text}`);
      parts.push(`OBJECTIVES (active this turn):\n${lines.join("\n")}`);
    }
    if (distant.length > 0) {
      const lines = distant.map(({ obj }) => {
        const hint = obj.position ? travelHint(stack.position, obj.position) : "elsewhere";
        return `[${obj.achieved ? "x" : " "}] ${obj.text} (${hint})`;
      });
      parts.push(`OFF-TILE OBJECTIVES (require travel):\n${lines.join("\n")}`);
    }
  }
  const here = stack.places[posKey(stack.position)];
  if (here) {
    parts.push(`CURRENT LOCATION (canonical description):\n${here}`);
  }
  if (stack.entries.length > 0) {
    parts.push(`ESTABLISHED WORLD:\n${stack.entries.map((e) => `- ${e}`).join("\n")}`);
  }
  if (stack.threads.length > 0) {
    parts.push(`ACTIVE THREADS:\n${stack.threads.map((t) => `- ${t}`).join("\n")}`);
  }
  // Append explicit per-turn naming directives LAST so they sit closest to the
  // player input — most recency-weighted position for next-token attention.
  const namingHints = findTargetNamingHints(activeObjs, stack.entries);
  if (namingHints.length > 0) {
    parts.push(
      `THIS TURN — NAME THESE ITEMS EXPLICITLY (use the exact noun, do not substitute or invent a decoy):\n${namingHints.join("\n")}`
    );
  }
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n\n`;
}

// Deterministic safety net for LOCATE-objective completion: if the player is
// on a LOCATE objective's target tile AND the new narrative contains the
// target noun as a whole word, return that objective's index. This backstops
// the archivist LLM which has been observed to miss obvious matches at higher
// temperatures or with abstract prompt examples.
export function inferLocateCompletions(
  objectives: Objective[],
  position: [number, number],
  narrative: string,
): number[] {
  const indices: number[] = [];
  for (let i = 0; i < objectives.length; i++) {
    const obj = objectives[i];
    if (!obj || obj.achieved) continue;
    // Must be a LOCATE-style objective.
    const anchor = locateObjectiveAnchor(obj.text);
    if (!anchor) continue;
    // Player must be on the objective's target tile.
    if (!obj.position) continue;
    if (obj.position[0] !== position[0] || obj.position[1] !== position[1]) continue;
    // Trailing-noun anchor whole-word search in the narrative.
    const re = new RegExp(`\\b${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(narrative)) indices.push(i);
  }
  return indices;
}

export function formatStackForArchivist(stack: WorldStack): string {
  const parts: string[] = [];
  const attrBlock = formatPlayerAttributesBlock(stack.attributes);
  if (attrBlock) parts.push(attrBlock);
  const facts =
    stack.entries.length === 0
      ? "CURRENT STACK: (empty)"
      : `CURRENT STACK:\n${stack.entries.map((e) => `- ${e}`).join("\n")}`;
  const threads =
    stack.threads.length === 0
      ? "ACTIVE THREADS: (none)"
      : `ACTIVE THREADS:\n${stack.threads.map((t) => `- ${t}`).join("\n")}`;
  parts.push(facts);
  parts.push(threads);
  if (stack.objectives.length > 0) {
    const lines = stack.objectives.map((o, i) => {
      const status = o.achieved ? "x" : " ";
      const distantFlag =
        o.position && manhattan(stack.position, o.position) > 0
          ? " [OFF-TILE — cannot be completed this turn]"
          : "";
      return `${i}: [${status}] ${o.text}${distantFlag}`;
    });
    parts.push(`OBJECTIVES:\n${lines.join("\n")}`);
  }
  return `${parts.join("\n\n")}\n\n`;
}

export function applyPresetToStack(preset: Preset): WorldStack {
  return {
    entries: [...preset.objects],
    threads: [],
    turn: 0,
    position: [0, 0],
    places: {},
    objectives: preset.objectives.map((o) => {
      const obj: Objective = { text: o.text, achieved: false };
      if (o.position) obj.position = [o.position[0], o.position[1]];
      return obj;
    }),
    presetSlug: preset.slug,
    attributes: preset.attributes.map((a) => ({ name: a.name, scope: [...a.scope] })),
  };
}

export function unionAchievedIndices(
  current: Objective[],
  achievedIndices: number[]
): Objective[] {
  const flips = new Set<number>();
  for (const i of achievedIndices) {
    if (Number.isInteger(i) && i >= 0 && i < current.length) {
      flips.add(i);
    }
  }
  return current.map((o, i) =>
    flips.has(i) && !o.achieved ? { ...o, achieved: true } : { ...o }
  );
}
