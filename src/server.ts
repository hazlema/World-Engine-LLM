import { appendFile, readdir, stat } from "node:fs/promises";
import { narratorTurn, archivistTurn, interpreterTurn, type InterpretedAction } from "./engine";
import {
  posKey,
  applyDirection,
  loadStack,
  saveStack,
  applyPresetToStack,
  unionAchievedIndices,
  inferLocateCompletions,
  type WorldStack,
  type Direction,
  type Objective,
} from "./stack";
import { loadAllPresets, type Preset } from "./presets";
import { synthesizeToFile } from "./tts";
import { spawnSidecar, waitForSidecarReady, isNarrationReady, listSidecarVoices } from "./sidecar";
import { generateImage, IMAGE_STYLES, DEFAULT_IMAGE_STYLE, type ImageStyle } from "./gemini-image";
import { warmupOpenRouter, logStartupRouting } from "./api";
import { loadConfig, type Config } from "./config";

// Default voice slug — must exist in tts_sidecar/voices/ after the user runs
// generate_voices.py. The runtime voice list is fetched from the sidecar.
const DEFAULT_VOICE = "noir";

let _voiceList: string[] = [];

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
  provider: "local" | "openrouter";
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
  archivist: { model: string };
  interpreter: { provider: "local" | "openrouter"; model: string };
  tts: { provider: string; voice: string };
  image: { provider: string; style: string };
  useGeminiImages: boolean;
  useNarration: boolean;
  narrationReady: boolean;
  voices: string[];
}

let serverConfig: Config | undefined;

/** For tests only — call before each test that exercises snapshotMessage or processInput. */
export function resetServerConfigForTesting(): void {
  serverConfig = undefined;
}

function getServerConfig(): Config {
  if (!serverConfig) serverConfig = loadConfig();
  return serverConfig;
}

function providerInfo(): ProviderInfo {
  const c = getServerConfig();
  return {
    narrator: { provider: c.narrator.provider, model: c.narrator.model },
    archivist: { model: c.archivist.model },
    interpreter: { provider: c.interpreter.provider, model: c.interpreter.model },
    tts: { provider: "chatterbox", voice: _voiceList[0] ?? DEFAULT_VOICE },
    image: { provider: "gemini", style: DEFAULT_IMAGE_STYLE },
    useGeminiImages: c.useGeminiImages,
    useNarration: c.useNarration,
    narrationReady: isNarrationReady(),
    voices: _voiceList,
  };
}

let lastTurnTrace: LastTurnTrace | null = null;
export function getLastTurnTrace(): LastTurnTrace | null {
  return lastTurnTrace;
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
    interpreter: { action: args.action.action, provider: getServerConfig().interpreter.provider },
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
  | { type: "audio-ready"; turnId: number; url: string }
  | { type: "audio-error"; turnId: number; message: string }
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

  // Generate (or cache-hit) the WAV file, then notify the originating client.
  // Runs in parallel with the archivist call below.
  const ttsPromise: Promise<void> = voice && sendAudio && getServerConfig().useNarration && isNarrationReady()
    ? (async () => {
        try {
          const url = await synthesizeToFile(narrative, voice);
          // turnId is the archivist's resulting turn number, which we don't know
          // yet here. The narrator/archivist sequence is per-turn, so stack.turn + 1
          // matches what the archivist will land on.
          sendAudio({ type: "audio-ready", turnId: stack.turn + 1, url });
        } catch (err) {
          console.error("[tts]", err);
          sendAudio({
            type: "audio-error",
            turnId: stack.turn + 1,
            message: err instanceof Error ? err.message : String(err),
          });
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
  // Backstop: even if the archivist missed an obvious LOCATE match, infer
  // completions from (player position, objective target, narrative text).
  const inferredIndices = inferLocateCompletions(stack.objectives, finalPosition, narrative);
  const combinedIndices = Array.from(
    new Set([...archived.achievedObjectiveIndices, ...inferredIndices])
  );
  const newObjectives = unionAchievedIndices(stack.objectives, combinedIndices);
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
        achievedObjectiveIndices: combinedIndices,
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
    providers: providerInfo(),
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
      // Fire-and-forget warmup so the first turn doesn't eat OpenRouter cold-start.
      warmupOpenRouter().catch(() => {});
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
    const voice = typeof msg.voice === "string" && msg.voice.length > 0
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
  serverConfig = loadConfig();
  logStartupRouting();

  if (serverConfig.useNarration) {
    console.log("[tts] spawning sidecar...");
    spawnSidecar();
    // Fire-and-forget — the server starts listening immediately; narration
    // becomes available once the sidecar reports ready.
    waitForSidecarReady().then(async (ready) => {
      if (ready) {
        _voiceList = await listSidecarVoices();
        console.log(`[tts] sidecar ready, voices: ${_voiceList.join(", ") || "(none — run generate_voices.py)"}`);
      } else {
        console.warn("[tts] sidecar did not become ready within timeout — narration disabled");
      }
    });
  } else {
    console.log("[tts] USE_NARRATION=false — sidecar not started, narration disabled");
  }

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
        if (!getServerConfig().useNarration) {
          return new Response("USE_NARRATION=false", { status: 503 });
        }
        if (!isNarrationReady()) {
          return new Response("sidecar warming up", { status: 503 });
        }
        return Response.json({ voices: _voiceList, default: _voiceList[0] ?? DEFAULT_VOICE });
      }
      if (url.pathname === "/api/voice-config" && req.method === "GET") {
        return Response.json({});
      }
      if (url.pathname === "/api/image" && req.method === "POST") {
        try {
          if (!getServerConfig().useGeminiImages) {
            return new Response("USE_GEMINI_IMAGES=false", { status: 503 });
          }
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
      if (url.pathname === "/api/media/save" && req.method === "POST") {
        try {
          const contentType = req.headers.get("content-type") || "";
          if (!contentType.startsWith("image/")) {
            return new Response("expected image/* content-type", { status: 400 });
          }
          const ext = contentType === "image/png" ? "png"
            : contentType === "image/jpeg" ? "jpg"
            : contentType === "image/webp" ? "webp"
            : null;
          if (!ext) return new Response(`unsupported image type: ${contentType}`, { status: 415 });
          const buf = await req.arrayBuffer();
          if (buf.byteLength === 0) return new Response("empty body", { status: 400 });
          if (buf.byteLength > 20 * 1024 * 1024) return new Response("image too large", { status: 413 });
          const filename = `${crypto.randomUUID()}.${ext}`;
          const filePath = new URL(`../media/${filename}`, import.meta.url).pathname;
          await Bun.write(filePath, buf);
          return Response.json({ filename });
        } catch (err) {
          console.error("[/api/media/save]", err);
          return new Response("save failed", { status: 500 });
        }
      }
      if (url.pathname === "/api/media" && req.method === "GET") {
        try {
          const mediaDir = new URL("../media/", import.meta.url).pathname;
          const entries = await readdir(mediaDir);
          const items: Array<{ name: string; mtime: number }> = [];
          for (const name of entries) {
            if (!/\.(png|jpe?g|webp|gif|avif)$/i.test(name)) continue;
            const s = await stat(`${mediaDir}/${name}`);
            items.push({ name, mtime: s.mtimeMs });
          }
          items.sort((a, b) => b.mtime - a.mtime);
          return Response.json({ items });
        } catch (err) {
          console.error("[/api/media]", err);
          return new Response("media listing failed", { status: 500 });
        }
      }
      if (url.pathname.startsWith("/media/") && req.method === "GET") {
        const rel = url.pathname.slice("/media/".length);
        if (!rel || rel.includes("/") || rel.includes("..") || rel.startsWith(".")) {
          return new Response("invalid path", { status: 400 });
        }
        const filePath = new URL(`../media/${rel}`, import.meta.url).pathname;
        const file = Bun.file(filePath);
        if (!(await file.exists())) return new Response("not found", { status: 404 });
        return new Response(file, { headers: { "Cache-Control": "public, max-age=300" } });
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
