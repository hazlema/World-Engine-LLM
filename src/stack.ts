const STACK_FILE = new URL("../world-stack.json", import.meta.url).pathname;
export const MAX_STACK_ENTRIES = 25;
export const MAX_THREADS = 10;

export type Position = [number, number];
export type Direction = "north" | "south" | "east" | "west";

export interface WorldStack {
  entries: string[];
  threads: string[];
  turn: number;
  position: Position;
  places: Record<string, string>;
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

export function applyDirection(p: Position, dir: Direction): Position {
  const d = DELTAS[dir];
  return [p[0] + d[0], p[1] + d[1]];
}

function emptyStack(): WorldStack {
  return { entries: [], threads: [], turn: 0, position: [0, 0], places: {} };
}

export async function loadStack(): Promise<WorldStack> {
  const file = Bun.file(STACK_FILE);
  if (!(await file.exists())) return emptyStack();
  try {
    const data = await file.json();
    if (
      data !== null &&
      typeof data === "object" &&
      Array.isArray(data.entries) &&
      typeof data.turn === "number"
    ) {
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
      return {
        entries: data.entries,
        threads: Array.isArray(data.threads) ? data.threads : [],
        turn: data.turn,
        position,
        places,
      };
    }
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

export function formatStackForNarrator(stack: WorldStack): string {
  const parts: string[] = [];
  const here = stack.places[posKey(stack.position)];
  if (here) {
    parts.push(`CURRENT LOCATION (canonical description):\n${here}`);
  }
  if (stack.entries.length > 0) {
    parts.push(`ESTABLISHED WORLD:\n${stack.entries.map(e => `- ${e}`).join("\n")}`);
  }
  if (stack.threads.length > 0) {
    parts.push(`ACTIVE THREADS:\n${stack.threads.map(t => `- ${t}`).join("\n")}`);
  }
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n\n`;
}

export function formatStackForArchivist(stack: WorldStack): string {
  const facts = stack.entries.length === 0
    ? "CURRENT STACK: (empty)"
    : `CURRENT STACK:\n${stack.entries.map(e => `- ${e}`).join("\n")}`;
  const threads = stack.threads.length === 0
    ? "ACTIVE THREADS: (none)"
    : `ACTIVE THREADS:\n${stack.threads.map(t => `- ${t}`).join("\n")}`;
  return `${facts}\n\n${threads}\n\n`;
}
