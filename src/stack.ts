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
  placeObjects: Record<string, RoomObject[]>;
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
    placeObjects: {},
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

  const placeObjects: Record<string, RoomObject[]> = {};
  if (data.placeObjects !== null && typeof data.placeObjects === "object" && !Array.isArray(data.placeObjects)) {
    for (const key of Object.keys(data.placeObjects)) {
      const arr = data.placeObjects[key];
      if (!Array.isArray(arr)) continue;
      const cleaned: RoomObject[] = [];
      for (const obj of arr) {
        if (!obj || typeof obj !== "object") continue;
        if (typeof obj.name !== "string" || obj.name.length === 0) continue;
        if (!Array.isArray(obj.states)) continue;
        if (!obj.states.every((s: any) => typeof s === "string")) continue;
        if (obj.category !== "item" && obj.category !== "fixture" && obj.category !== "feature" && obj.category !== "character") continue;
        const ro: RoomObject = {
          name: obj.name,
          states: [...obj.states],
          category: obj.category,
        };
        if (typeof obj.location === "string" && obj.location.length > 0) {
          ro.location = obj.location;
        }
        cleaned.push(ro);
      }
      placeObjects[key] = cleaned;
    }
  }

  return {
    entries: data.entries,
    threads: Array.isArray(data.threads) ? data.threads : [],
    turn: data.turn,
    position,
    places,
    objectives,
    presetSlug,
    attributes,
    placeObjects,
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

// Cheap trailing-noun extraction for threads. Mirrors locateObjectiveAnchor's
// last-word-length>2 rule. Used only as a prompt-side hint; the safety net is
// the real guard against the archivist dropping critical objects.
function trailingNoun(text: string): string | null {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 2);
  const last = words[words.length - 1];
  if (!last) return null;
  return last.replace(/[^a-z0-9]/gi, "").toLowerCase() || null;
}

export function extractPinnedNames(
  objectives: Objective[],
  threads: string[]
): Set<string> {
  const names = new Set<string>();
  for (const obj of objectives) {
    if (obj.achieved) continue;
    const anchor = locateObjectiveAnchor(obj.text);
    if (anchor) names.add(anchor);
    // Also pull trailing noun for non-LOCATE objectives ("open the iron chest").
    if (!anchor) {
      const n = trailingNoun(obj.text);
      if (n) names.add(n);
    }
  }
  for (const t of threads) {
    const n = trailingNoun(t);
    if (n) names.add(n);
  }
  return names;
}

const PLAYER_NAME_PREFIXES = [
  /^your\s+/i,
  /^the\s+player'?s\s+/i,
  /^player'?s\s+/i,
];

function isPlayerSelfReferential(name: string): boolean {
  return PLAYER_NAME_PREFIXES.some((re) => re.test(name));
}

function priorityRank(p: "high" | "normal" | "low"): number {
  return p === "high" ? 2 : p === "normal" ? 1 : 0;
}

function stateChanged(current: RoomObject, prior: RoomObject[]): boolean {
  const match = prior.find((p) => p.name.toLowerCase() === current.name.toLowerCase());
  if (!match) return true; // brand-new object counts as a change
  if (match.states.length !== current.states.length) return true;
  for (const s of current.states) if (!match.states.includes(s)) return true;
  return false;
}

// Post-archivist deterministic pass. Input: archivist's returned objects for
// the current tile, the prior turn's objects for the same tile, and the set
// of pinned names (from objectives + threads).
//
// The function: (1) drops player-self-referential names, (2) force-pins
// objects whose names are in the pinned set to "high" priority for eviction,
// (3) restores any pinned name that is missing from the archivist output but
// existed in prior state, (4) enforces MAX_PLACE_OBJECTS by dropping
// lowest-priority objects first; within a tier, prefers dropping objects with
// no state change this turn.
//
// Never invents objects. Restoration only re-injects entries from prior state.
export function applyRoomObjectsSafetyNet(
  archivistObjects: RoomObject[],
  priorObjects: RoomObject[],
  pinnedNames: Set<string>
): RoomObject[] {
  // 1. Drop player-self-referential objects.
  const filtered = archivistObjects.filter((o) => !isPlayerSelfReferential(o.name));

  // 2. Track which names are present, lowercased for matching.
  const presentNames = new Set(filtered.map((o) => o.name.toLowerCase()));

  // 3. Restore pinned objects missing from archivist output, using prior state.
  const restored: RoomObject[] = [...filtered];
  for (const name of pinnedNames) {
    if (presentNames.has(name.toLowerCase())) continue;
    const priorMatch = priorObjects.find((o) => o.name.toLowerCase().includes(name.toLowerCase()));
    if (priorMatch) {
      console.warn(`[room-state] archivist dropped pinned object: ${priorMatch.name}`);
      restored.push({ ...priorMatch, states: [...priorMatch.states] });
    }
  }

  // 4. Compute effective priority and per-object state-change flag.
  const annotated = restored.map((o) => {
    const isPinned = Array.from(pinnedNames).some((p) =>
      o.name.toLowerCase().includes(p.toLowerCase())
    );
    const basePriority = CATEGORY_PRIORITY[o.category];
    const effective: "high" | "normal" | "low" = isPinned ? "high" : basePriority;
    return { obj: o, priority: effective, changed: stateChanged(o, priorObjects) };
  });

  // 5. Cap enforcement: highest priority first, changed-this-turn breaks ties.
  if (annotated.length <= MAX_PLACE_OBJECTS) {
    return annotated.map((x) => x.obj);
  }
  annotated.sort((a, b) => {
    const pDiff = priorityRank(b.priority) - priorityRank(a.priority);
    if (pDiff !== 0) return pDiff;
    return (b.changed ? 1 : 0) - (a.changed ? 1 : 0);
  });
  return annotated.slice(0, MAX_PLACE_OBJECTS).map((x) => x.obj);
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
    placeObjects: {},
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
