import { appendFile } from "node:fs/promises";
import { narratorTurn, archivistTurn, interpreterTurn, type InterpretedAction } from "./engine";
import { posKey, applyDirection, loadStack, saveStack, type WorldStack, type Direction } from "./stack";

const PLAY_LOG_FILE = new URL("../play-log.jsonl", import.meta.url).pathname;

async function appendPlayLog(turn: number, input: string, narrative: string, position: [number, number]): Promise<void> {
  const entry = JSON.stringify({ ts: new Date().toISOString(), turn, input, position, narrative });
  try {
    await appendFile(PLAY_LOG_FILE, entry + "\n");
  } catch (err) {
    console.error("[play-log] append failed:", err);
  }
}

export type ServerMessage =
  | { type: "snapshot"; turn: number; entries: string[]; threads: string[] }
  | { type: "turn-start"; input: string }
  | { type: "narrative"; text: string }
  | { type: "stack-update"; entries: string[]; threads: string[] }
  | { type: "error"; source: "narrator" | "archivist"; message: string };

export type ClientMessage =
  | { type: "input"; text: string }
  | { type: "reset" }
  | { type: "hello" };

export type Send = (message: ServerMessage) => void;

const ACTION_TO_DIRECTION: Record<string, Direction> = {
  "move-north": "north",
  "move-south": "south",
  "move-east": "east",
  "move-west": "west",
};

export async function processInput(
  stack: WorldStack,
  input: string,
  send: Send
): Promise<WorldStack> {
  send({ type: "turn-start", input });

  // 1. Interpret intent — fall back to stay on failure.
  let action: InterpretedAction;
  try {
    action = await interpreterTurn(input);
  } catch {
    action = { action: "stay" };
  }

  // 2. Compute prospective target tile.
  const dir = ACTION_TO_DIRECTION[action.action];
  const prospective = dir ? applyDirection(stack.position, dir) : stack.position;

  // 3. Build a stack for the narrator with position pre-set to the prospective target,
  //    so formatStackForNarrator surfaces the canonical description (if any).
  const narratorStack: WorldStack = { ...stack, position: prospective };

  let narrative: string;
  try {
    narrative = await narratorTurn(narratorStack, input);
    send({ type: "narrative", text: narrative });
  } catch (err) {
    send({ type: "error", source: "narrator", message: String(err) });
    return stack;
  }

  // 4. Archive — extracts entries, threads, moved confirmation, location description.
  let archived;
  try {
    archived = await archivistTurn(stack, narrative);
  } catch (err) {
    send({ type: "error", source: "archivist", message: String(err) });
    return stack;
  }

  // 5. Resolve final position: only commit the move if archivist confirms.
  const finalPosition = dir && archived.moved ? prospective : stack.position;

  // 6. Capture canonical description on first visit only.
  const finalKey = posKey(finalPosition);
  const places = { ...stack.places };
  if (!places[finalKey] && archived.locationDescription) {
    places[finalKey] = archived.locationDescription;
  }

  const newStack: WorldStack = {
    entries: archived.entries,
    threads: archived.threads,
    turn: archived.turn,
    position: finalPosition,
    places,
  };

  await appendPlayLog(archived.turn, input, narrative, finalPosition);

  send({
    type: "stack-update",
    entries: newStack.entries,
    threads: newStack.threads,
  });

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
    });
    return;
  }

  if (msg.type === "reset") {
    const fresh: WorldStack = { entries: [], threads: [], turn: 0, position: [0, 0], places: {} };
    try {
      await saveStack(fresh);
      currentStack = fresh;
      broadcast({
        type: "snapshot",
        turn: 0,
        entries: [],
        threads: [],
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
