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
import { loadAllPresets, type Preset } from "./presets";
import { synthesizeStream, GEMINI_VOICES, DEFAULT_VOICE } from "./gemini-tts";
import { generateImage, IMAGE_STYLES, DEFAULT_IMAGE_STYLE, type ImageStyle } from "./gemini-image";

let presets: Map<string, Preset> = new Map();

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
  body: string;
}

export interface InterpreterTrace {
  action: InterpretedAction["action"];
  provider: "local" | "gemini";
}

export interface ArchivistTrace {
  entries: string[];
  threads: string[];
  achievedObjectiveIndices: number[];
  moved: boolean;
  locationDescription: string;
}

export interface LastTurnTrace {
  ts: string;
  turn: number;
  input: string;
  interpreter: InterpreterTrace;
  archivist: ArchivistTrace | null;
  error?: { source: "narrator" | "archivist" | "interpreter"; message: string };
}

export interface ProviderInfo {
  narrator: { provider: string; model: string };
  interpreter: { provider: "local" | "gemini" };
  tts: { provider: string; voice: string };
  image: { provider: string; style: string };
}

function buildProviderInfo(): ProviderInfo {
  const localModel = process.env.LOCAL_MODEL || "google/gemma-3-12b";
  const narratorProvider = process.env.NARRATOR_PROVIDER || "local";
  const narratorGeminiModel = process.env.NARRATOR_GEMINI_MODEL || "gemini-2.5-flash";
  return {
    narrator: {
      provider: narratorProvider,
      model: narratorProvider === "gemini" ? narratorGeminiModel : localModel,
    },
    interpreter: { provider: interpreterProvider() },
    tts: { provider: "gemini", voice: DEFAULT_VOICE },
    image: { provider: "gemini", style: DEFAULT_IMAGE_STYLE },
  };
}

const PROVIDER_INFO: ProviderInfo = buildProviderInfo();

let lastTurnTrace: LastTurnTrace | null = null;
export function getLastTurnTrace(): LastTurnTrace | null {
  return lastTurnTrace;
}

function interpreterProvider(): "local" | "gemini" {
  return process.env.INTERPRETER_PROVIDER === "gemini" ? "gemini" : "local";
}

function buildLastTurnTrace(args: {
  turn: number;
  input: string;
  action: InterpretedAction;
  archivist: ArchivistTrace | null;
  error?: { source: "narrator" | "archivist" | "interpreter"; message: string };
}): LastTurnTrace {
  return {
    ts: new Date().toISOString(),
    turn: args.turn,
    input: args.input,
    interpreter: { action: args.action.action, provider: interpreterProvider() },
    archivist: args.archivist,
    ...(args.error ? { error: args.error } : {}),
  };
}

export type ServerMessage =
  | {
      type: "snapshot";
      turn: number;
      entries: string[];
      threads: string[];
      objectives: Objective[];
      position: [number, number];
      presetSlug: string | null;
      presets: PresetSummary[];
      providers: ProviderInfo;
    }
  | { type: "turn-start"; input: string }
  | { type: "narrative"; text: string }
  | {
      type: "stack-update";
      entries: string[];
      threads: string[];
      objectives: Objective[];
      position: [number, number];
    }
  | { type: "win" }
  | { type: "audio-start" }
  | { type: "audio-chunk"; data: string }
  | { type: "audio-end" }
  | { type: "move-blocked"; input: string }
  | { type: "error"; source: "narrator" | "archivist" | "interpreter"; message: string }
  | { type: "debug-trace"; trace: LastTurnTrace };

export type ClientMessage =
  | { type: "input"; text: string; voice?: string }
  | { type: "start"; presetSlug: string | null }
  | { type: "keep-exploring" }
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
  briefing?: string,
  voice?: string,
  sendAudio?: Send
): Promise<WorldStack> {
  let action: InterpretedAction;
  try {
    action = await interpreterTurn(input);
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err);
    console.error("[interpreter] failed, falling back to stay:", message);
    send({ type: "error", source: "interpreter", message });
    action = { action: "stay" };
  }

  if (action.action === "move-blocked") {
    send({ type: "move-blocked", input });
    try {
      lastTurnTrace = buildLastTurnTrace({ turn: stack.turn, input, action, archivist: null });
      send({ type: "debug-trace", trace: lastTurnTrace });
    } catch (err) {
      console.error("[debug-trace] capture failed:", err);
    }
    return stack;
  }

  // Fires after classification so a `move-blocked` short-circuit doesn't leave a stale pending turn in the UI.
  send({ type: "turn-start", input });

  const dir = ACTION_TO_DIRECTION[action.action];
  const prospective = dir ? applyDirection(stack.position, dir) : stack.position;
  const narratorStack: WorldStack = { ...stack, position: prospective };

  let narrative: string;
  try {
    narrative = await narratorTurn(narratorStack, input, briefing);
    send({ type: "narrative", text: narrative });
  } catch (err) {
    const message = String(err);
    send({ type: "error", source: "narrator", message });
    try {
      lastTurnTrace = buildLastTurnTrace({
        turn: stack.turn,
        input,
        action,
        archivist: null,
        error: { source: "narrator", message },
      });
      send({ type: "debug-trace", trace: lastTurnTrace });
    } catch (e) {
      console.error("[debug-trace] capture failed:", e);
    }
    return stack;
  }

  // Start TTS streaming immediately after narrative; runs in parallel with archivist.
  // Pushes audio-start / audio-chunk* / audio-end to the requesting client only.
  const ttsPromise: Promise<void> = voice && sendAudio
    ? (async () => {
        try {
          sendAudio({ type: "audio-start" });
          const stream = synthesizeStream(narrative, voice);
          const reader = stream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length > 0) {
              sendAudio({ type: "audio-chunk", data: Buffer.from(value).toString("base64") });
            }
          }
        } catch (err) {
          console.error("[tts]", err);
        } finally {
          sendAudio({ type: "audio-end" });
        }
      })()
    : Promise.resolve();

  let archived;
  try {
    archived = await archivistTurn(stack, narrative);
  } catch (err) {
    const message = String(err);
    send({ type: "error", source: "archivist", message });
    try {
      lastTurnTrace = buildLastTurnTrace({
        turn: stack.turn,
        input,
        action,
        archivist: null,
        error: { source: "archivist", message },
      });
      send({ type: "debug-trace", trace: lastTurnTrace });
    } catch (e) {
      console.error("[debug-trace] capture failed:", e);
    }
    return stack;
  }

  // Interpreter is authoritative for cardinal movement: a discrete grid has
  // no "in transit" state, so a successfully classified move-{cardinal} always
  // lands on the prospective tile. The archivist's `moved` flag is informational.
  const finalPosition = dir ? prospective : stack.position;
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
    position: newStack.position,
  });

  try {
    lastTurnTrace = buildLastTurnTrace({
      turn: archived.turn,
      input,
      action,
      archivist: {
        entries: archived.entries,
        threads: archived.threads,
        achievedObjectiveIndices: archived.achievedObjectiveIndices,
        moved: archived.moved,
        locationDescription: archived.locationDescription,
      },
    });
    send({ type: "debug-trace", trace: lastTurnTrace });
  } catch (err) {
    console.error("[debug-trace] capture failed:", err);
  }

  if (isAllDone && !wasAllDone) {
    send({ type: "win" });
  }

  // Wait for TTS streaming to finish before resolving.
  await ttsPromise;

  return newStack;
}

let currentStack: WorldStack;

function presetSummaries(): PresetSummary[] {
  return [...presets.values()].map((p) => ({
    slug: p.slug,
    title: p.title,
    description: p.description,
    body: p.body,
  }));
}

export function snapshotMessage(stack: WorldStack): ServerMessage {
  return {
    type: "snapshot",
    turn: stack.turn,
    entries: stack.entries,
    threads: stack.threads,
    objectives: stack.objectives,
    position: stack.position,
    presetSlug: stack.presetSlug,
    presets: presetSummaries(),
    providers: PROVIDER_INFO,
  };
}

async function handleClientMessage(
  raw: string,
  send: Send,
  broadcast: Send
): Promise<void> {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    send({ type: "error", source: "narrator", message: "Invalid client message" });
    return;
  }

  if (msg.type === "hello") {
    send(snapshotMessage(currentStack));
    return;
  }

  if (msg.type === "start") {
    let next: WorldStack;
    if (msg.presetSlug === null) {
      next = emptyWorld();
    } else {
      const preset = presets.get(msg.presetSlug);
      if (!preset) {
        send({
          type: "error",
          source: "archivist",
          message: `Unknown preset: ${msg.presetSlug}`,
        });
        return;
      }
      next = startWithPreset(preset);
    }
    try {
      await saveStack(next);
      currentStack = next;
      broadcast(snapshotMessage(currentStack));
    } catch (err) {
      send({ type: "error", source: "archivist", message: `Start failed: ${err}` });
    }
    return;
  }

  if (msg.type === "keep-exploring") {
    const next = keepExploring(currentStack);
    try {
      await saveStack(next);
      currentStack = next;
      broadcast(snapshotMessage(currentStack));
    } catch (err) {
      send({ type: "error", source: "archivist", message: `Save failed: ${err}` });
    }
    return;
  }

  if (msg.type === "input") {
    const voice = typeof msg.voice === "string" && GEMINI_VOICES.includes(msg.voice)
      ? msg.voice
      : undefined;
    const briefing = currentStack.presetSlug
      ? presets.get(currentStack.presetSlug)?.body
      : undefined;
    const newStack = await processInput(currentStack, msg.text, broadcast, briefing, voice, send);
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
  presets = await loadAllPresets();
  currentStack = await loadStack();

  const indexHtml = await import("./web/index.html");

  const server = Bun.serve({
    port: 3000,
    idleTimeout: 120,
    routes: {
      "/": indexHtml.default,
    },
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("Upgrade required", { status: 426 });
      }
      if (url.pathname === "/api/voices" && req.method === "GET") {
        return Response.json({ voices: GEMINI_VOICES, default: DEFAULT_VOICE });
      }
      if (url.pathname === "/api/speak" && req.method === "POST") {
        try {
          const body = await req.json() as { text?: unknown; voice?: unknown };
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text) return new Response("text required", { status: 400 });
          if (text.length > 4000) return new Response("text too long", { status: 413 });
          const voice = typeof body.voice === "string" && GEMINI_VOICES.includes(body.voice)
            ? body.voice
            : DEFAULT_VOICE;
          const stream = synthesizeStream(text, voice);
          return new Response(stream, {
            headers: {
              "Content-Type": "audio/pcm",
              "Cache-Control": "no-store",
            },
          });
        } catch (err) {
          console.error("[/api/speak]", err);
          return new Response("speak failed", { status: 500 });
        }
      }
      if (url.pathname === "/api/voice-config" && req.method === "GET") {
        return Response.json({});
      }
      if (url.pathname === "/api/image" && req.method === "POST") {
        try {
          const body = await req.json() as { text?: unknown; style?: unknown };
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text) return new Response("text required", { status: 400 });
          if (text.length > 4000) return new Response("text too long", { status: 413 });
          const style: ImageStyle = typeof body.style === "string" && (IMAGE_STYLES as readonly string[]).includes(body.style)
            ? body.style as ImageStyle
            : DEFAULT_IMAGE_STYLE;
          const png = await generateImage(text, style);
          return new Response(png, {
            headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
          });
        } catch (err) {
          console.error("[/api/image]", err);
          const message = err instanceof Error ? err.message : String(err);
          return new Response(message.slice(0, 500), { status: 500 });
        }
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
