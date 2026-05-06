import type { Preset } from "./presets";

const STACK_FILE = new URL("../world-stack.json", import.meta.url).pathname;
export const MAX_STACK_ENTRIES = 25;
export const MAX_THREADS = 10;

export type Position = [number, number];
export type Direction = "north" | "south" | "east" | "west";

export interface Objective {
  text: string;
  achieved: boolean;
}

export interface WorldStack {
  entries: string[];
  threads: string[];
  turn: number;
  position: Position;
  places: Record<string, string>;
  objectives: Objective[];
  presetSlug: string | null;
}

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
        .map((o: any) => ({ text: o.text, achieved: o.achieved }))
    : [];
  const presetSlug: string | null =
    typeof data.presetSlug === "string" ? data.presetSlug : null;

  return {
    entries: data.entries,
    threads: Array.isArray(data.threads) ? data.threads : [],
    turn: data.turn,
    position,
    places,
    objectives,
    presetSlug,
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

export function formatStackForNarrator(stack: WorldStack, briefing?: string): string {
  const parts: string[] = [];
  if (briefing && briefing.trim().length > 0) {
    parts.push(`MISSION BRIEFING (durable premise):\n${briefing.trim()}`);
  }
  if (stack.objectives.length > 0) {
    const lines = stack.objectives.map(
      (o) => `[${o.achieved ? "x" : " "}] ${o.text}`
    );
    parts.push(`OBJECTIVES:\n${lines.join("\n")}`);
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
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n\n`;
}

export function formatStackForArchivist(stack: WorldStack): string {
  const facts =
    stack.entries.length === 0
      ? "CURRENT STACK: (empty)"
      : `CURRENT STACK:\n${stack.entries.map((e) => `- ${e}`).join("\n")}`;
  const threads =
    stack.threads.length === 0
      ? "ACTIVE THREADS: (none)"
      : `ACTIVE THREADS:\n${stack.threads.map((t) => `- ${t}`).join("\n")}`;
  const parts = [facts, threads];
  if (stack.objectives.length > 0) {
    const lines = stack.objectives.map(
      (o, i) => `${i}: [${o.achieved ? "x" : " "}] ${o.text}`
    );
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
    objectives: preset.objectives.map((text) => ({ text, achieved: false })),
    presetSlug: preset.slug,
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
