import { appendFile } from "node:fs/promises";
import { narratorTurn, archivistTurn, interpreterTurn, type InterpretedAction } from "./engine";
import {
  posKey,
  applyDirection,
  loadStack,
  saveStack,
  applyPresetToStack,
  unionAchievedIndices,
  type WorldStack,
  type Direction,
  type Objective,
} from "./stack";
import type { Preset } from "./presets";

const PLAY_LOG_FILE = new URL("../play-log.jsonl", import.meta.url).pathname;

async function appendPlayLog(turn: number, input: string, narrative: string, position: [number, number]): Promise<void> {
  const entry = JSON.stringify({ ts: new Date().toISOString(), turn, input, position, narrative });
  try {
    await appendFile(PLAY_LOG_FILE, entry + "\n");
  } catch (err) {
    console.error("[play-log] append failed:", err);
  }
}

export interface PresetSummary {
  slug: string;
  title: string;
  description: string;
}

export type ServerMessage =
  | {
      type: "snapshot";
      turn: number;
      entries: string[];
      threads: string[];
      objectives: Objective[];
      presetSlug: string | null;
      presets: PresetSummary[];
    }
  | { type: "turn-start"; input: string }
  | { type: "narrative"; text: string }
  | {
      type: "stack-update";
      entries: string[];
      threads: string[];
      objectives: Objective[];
    }
  | { type: "win" }
  | { type: "error"; source: "narrator" | "archivist"; message: string };

export type ClientMessage =
  | { type: "input"; text: string }
  | { type: "start"; presetSlug: string | null }
  | { type: "keep-exploring" }
  | { type: "reset" }   // TODO Task 7: remove when handleClientMessage rewrites the reset branch
  | { type: "hello" };

export type Send = (message: ServerMessage) => void;

const ACTION_TO_DIRECTION: Record<string, Direction> = {
  "move-north": "north",
  "move-south": "south",
  "move-east": "east",
  "move-west": "west",
};

export function startWithPreset(preset: Preset): WorldStack {
  return applyPresetToStack(preset);
}

export function emptyWorld(): WorldStack {
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

export function keepExploring(stack: WorldStack): WorldStack {
  return { ...stack, presetSlug: null };
}

export async function processInput(
  stack: WorldStack,
  input: string,
  send: Send,
  briefing?: string
): Promise<WorldStack> {
  send({ type: "turn-start", input });

  let action: InterpretedAction;
  try {
    action = await interpreterTurn(input);
  } catch {
    action = { action: "stay" };
  }

  const dir = ACTION_TO_DIRECTION[action.action];
  const prospective = dir ? applyDirection(stack.position, dir) : stack.position;
  const narratorStack: WorldStack = { ...stack, position: prospective };

  let narrative: string;
  try {
    narrative = await narratorTurn(narratorStack, input, briefing);
    send({ type: "narrative", text: narrative });
  } catch (err) {
    send({ type: "error", source: "narrator", message: String(err) });
    return stack;
  }

  let archived;
  try {
    archived = await archivistTurn(stack, narrative);
  } catch (err) {
    send({ type: "error", source: "archivist", message: String(err) });
    return stack;
  }

  const finalPosition = dir && archived.moved ? prospective : stack.position;
  const finalKey = posKey(finalPosition);
  const places = { ...stack.places };
  if (!places[finalKey] && archived.locationDescription) {
    places[finalKey] = archived.locationDescription;
  }

  const wasAllDone =
    stack.objectives.length > 0 && stack.objectives.every((o) => o.achieved);
  const newObjectives = unionAchievedIndices(
    stack.objectives,
    archived.achievedObjectiveIndices
  );
  const isAllDone =
    newObjectives.length > 0 && newObjectives.every((o) => o.achieved);

  const newStack: WorldStack = {
    entries: archived.entries,
    threads: archived.threads,
    turn: archived.turn,
    position: finalPosition,
    places,
    objectives: newObjectives,
    presetSlug: stack.presetSlug,
  };

  await appendPlayLog(archived.turn, input, narrative, finalPosition);

  send({
    type: "stack-update",
    entries: newStack.entries,
    threads: newStack.threads,
    objectives: newStack.objectives,
  });

  if (isAllDone && !wasAllDone) {
    send({ type: "win" });
  }

  return newStack;
}

let currentStack: WorldStack;

async function handleClientMessage(raw: string, send: Send, broadcast: Send): Promise<void> {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    send({ type: "error", source: "narrator", message: "Invalid client message" });
    return;
  }

  if (msg.type === "hello") {
    send({
      type: "snapshot",
      turn: currentStack.turn,
      entries: currentStack.entries,
      threads: currentStack.threads,
      objectives: currentStack.objectives,
      presetSlug: currentStack.presetSlug,
      presets: [],
    });
    return;
  }

  if (msg.type === "reset") {
    const fresh: WorldStack = { entries: [], threads: [], turn: 0, position: [0, 0], places: {}, objectives: [], presetSlug: null };
    try {
      await saveStack(fresh);
      currentStack = fresh;
      broadcast({
        type: "snapshot",
        turn: 0,
        entries: [],
        threads: [],
        objectives: [],
        presetSlug: null,
        presets: [],
      });
    } catch (err) {
      send({ type: "error", source: "archivist", message: `Reset failed: ${err}` });
    }
    return;
  }

  if (msg.type === "input") {
    const newStack = await processInput(currentStack, msg.text, broadcast);
    if (newStack !== currentStack) {
      currentStack = newStack;
      try {
        await saveStack(currentStack);
      } catch (err) {
        broadcast({
          type: "error",
          source: "archivist",
          message: `Save failed: ${err}`,
        });
      }
    }
  }
}

async function main() {
  currentStack = await loadStack();

  const indexHtml = await import("./web/index.html");

  const server = Bun.serve({
    port: 3000,
    routes: {
      "/": indexHtml.default,
    },
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("Upgrade required", { status: 426 });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.subscribe("world");
      },
      async message(ws, message) {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        await handleClientMessage(
          text,
          (m) => ws.send(JSON.stringify(m)),
          (m) => server.publish("world", JSON.stringify(m))
        );
      },
      close(ws) {
        ws.unsubscribe("world");
      },
    },
    development: {
      hmr: true,
      console: true,
    },
  });

  console.log(`World Engine listening at http://localhost:${server.port}`);
}

if (import.meta.main) {
  main();
}
