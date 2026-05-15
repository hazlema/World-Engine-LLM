import React, { useEffect, useRef, useState, useCallback } from "react";
import { PlaybackController } from "./playback-controller";
import { createRoot } from "react-dom/client";
import { diffNewItems } from "./utils";
import { parseSlashCommand } from "./slash";

type Turn = {
  id: number;
  input: string;
  narrative?: string;
  error?: string;
  pending: boolean;
};

type SystemTurn = {
  id: number;
  kind: "system";
  title: string;
  items: string[];
  variant?: "threads" | "briefing" | "blocked";
};

type AnyTurn = Turn | SystemTurn;

type Position = [number, number];
type Objective = { text: string; achieved: boolean; position?: Position };

type PresetSummary = {
  slug: string;
  title: string;
  description: string;
  body: string;
  hasBanner: boolean;
};

type Stack = {
  turn: number;
  entries: string[];
  threads: string[];
  objectives: Objective[];
  presetSlug: string | null;
  position: Position;
};

type ToastData =
  | { kind: "world-update"; entries: string[]; threads: string[]; id: number }
  | { kind: "blocked"; text: string; id: number };

type InterpreterTrace = { action: string; provider: "local" | "openrouter" };
type ArchivistTrace = {
  entries: string[];
  threads: string[];
  achievedObjectiveIndices: number[];
  moved: boolean;
  locationDescription: string;
};
type LastTurnTrace = {
  ts: string;
  turn: number;
  input: string;
  interpreter: InterpreterTrace;
  archivist: ArchivistTrace | null;
  error?: { source: "narrator" | "archivist" | "interpreter"; message: string };
};
type ProviderInfo = {
  narrator: { provider: string; model: string };
  archivist: { model: string };
  interpreter: { provider: "local" | "openrouter"; model: string };
  tts: { provider: string; voice: string };
  image: { provider: string; style: string };
  useGeminiImages: boolean;
  useNarration: boolean;
  narrationReady: boolean;
  voices: string[];
};

type ServerMessage =
  | {
      type: "snapshot";
      turn: number;
      entries: string[];
      threads: string[];
      objectives: Objective[];
      position: Position;
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
      position: Position;
    }
  | { type: "win" }
  | { type: "audio-ready"; turnId: number; url: string }
  | { type: "audio-error"; turnId: number; message: string }
  | { type: "move-blocked"; input: string }
  | { type: "error"; source: "narrator" | "archivist" | "interpreter"; message: string }
  | { type: "debug-trace"; trace: LastTurnTrace };

const QUICK_ACTIONS = [
  "look around",
  "wait",
  "north",
  "south",
  "east",
  "west",
];

function isSystemTurn(t: AnyTurn): t is SystemTurn {
  return (t as SystemTurn).kind === "system";
}

function narratableText(t: AnyTurn): string | null {
  if (isSystemTurn(t)) {
    return t.variant === "briefing" ? t.items.join("\n\n") : null;
  }
  return t.narrative ?? null;
}

function App() {
  const [connected, setConnected] = useState(false);
  const [turns, setTurns] = useState<AnyTurn[]>([]);
  const [stack, setStack] = useState<Stack>({
    turn: 0,
    entries: [],
    threads: [],
    objectives: [],
    presetSlug: null,
    position: [0, 0],
  });
  const [pending, setPending] = useState(false);
  const [inputValue, setInputValue] = useState("");
  type ModalView = null | "select" | "win" | "voice" | "image" | "inventory" | "debug" | "gallery";
  const [modal, setModal] = useState<ModalView>(null);
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [hasStarted, setHasStarted] = useState(false);
  const [narrationOn, setNarrationOn] = useState<boolean>(() => {
    try { return localStorage.getItem("narrationOn") === "1"; } catch { return false; }
  });
  const [audioByTurn, setAudioByTurn] = useState<Record<number, string>>({});
  const [imageByTurn, setImageByTurn] = useState<Record<number, string>>({});
  const [imagePending, setImagePending] = useState<Set<number>>(() => new Set());
  const [renderPending, setRenderPending] = useState<Set<number>>(() => new Set());
  // Sticky once true: stops auto-render from retrying when the server reports
  // GEMINI_API_KEY missing. Either path (image or TTS) can flip it.
  const [geminiUnavailable, setGeminiUnavailable] = useState(false);
  const [imagesOn, setImagesOn] = useState<boolean>(() => {
    try { return localStorage.getItem("imagesOn") === "1"; } catch { return false; }
  });
  const [imageStyle, setImageStyle] = useState<string>(() => {
    try { return localStorage.getItem("imageStyle") || "cinematic"; } catch { return "cinematic"; }
  });
  const IMAGE_STYLES = ["cinematic", "painterly", "noir", "photoreal", "anime"];
  const [voices, setVoices] = useState<string[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>(() => {
    try { return localStorage.getItem("narrationVoice") || ""; } catch { return ""; }
  });
  const [volume, setVolume] = useState<number>(() => {
    try {
      const v = parseFloat(localStorage.getItem("narrationVolume") || "");
      return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1.0;
    } catch { return 1.0; }
  });
  const [providers, setProviders] = useState<ProviderInfo | null>(null);
  const [lastTrace, setLastTrace] = useState<LastTurnTrace | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const playbackRef = useRef<PlaybackController | null>(null);
  if (!playbackRef.current) playbackRef.current = new PlaybackController();

  const [playbackState, setPlaybackState] = useState<{
    state: "idle" | "playing" | "paused";
    currentTurnId: number | null;
  }>({ state: "idle", currentTurnId: null });

  useEffect(() => {
    const pc = playbackRef.current;
    if (!pc) return;
    pc.onStateChange = (state, currentTurnId) => {
      setPlaybackState({ state, currentTurnId });
    };
    return () => { pc.onStateChange = undefined; };
  }, []);

  const [entriesCollapsed, toggleEntries] = useCollapsed("rail.entriesCollapsed", true);
  const [threadsCollapsed, toggleThreads] = useCollapsed("rail.threadsCollapsed", true);
  // Refs so the WebSocket handler (set up once on mount) always reads current values.
  const narrationOnRef = useRef(narrationOn);
  narrationOnRef.current = narrationOn;
  const imagesOnRef = useRef(imagesOn);
  imagesOnRef.current = imagesOn;
  const entriesCollapsedRef = useRef(entriesCollapsed);
  const threadsCollapsedRef = useRef(threadsCollapsed);
  entriesCollapsedRef.current = entriesCollapsed;
  threadsCollapsedRef.current = threadsCollapsed;
  const [toast, setToast] = useState<ToastData | null>(null);

  // Actions menu (collapsed quick-action list under one button)
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!actionsOpen) return;
    function onMousedown(e: MouseEvent) {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) {
        setActionsOpen(false);
      }
    }
    document.addEventListener("mousedown", onMousedown);
    return () => document.removeEventListener("mousedown", onMousedown);
  }, [actionsOpen]);

  // One-time voice list fetch; falls back silently if the server isn't ready.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/voices")
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`)))
      .then((data: { voices: string[]; default: string }) => {
        if (cancelled) return;
        setVoices(data.voices);
        setSelectedVoice((prev) => prev && data.voices.includes(prev) ? prev : data.default);
      })
      .catch(() => { /* voices stays empty; picker hides */ });
    return () => { cancelled = true; };
  }, []);

  // The /api/voices fetch above usually 503s on first load because the
  // sidecar is still warming up. Once the snapshot's providers.voices
  // populates (after the sidecar-ready broadcast), seed selectedVoice
  // and the local voices list from there.
  useEffect(() => {
    const sidecarVoices = providers?.voices ?? [];
    if (sidecarVoices.length === 0) return;
    setVoices((prev) => prev.length > 0 ? prev : sidecarVoices);
    setSelectedVoice((prev) => prev && sidecarVoices.includes(prev) ? prev : sidecarVoices[0]);
  }, [providers?.voices]);

  const renderImage = useCallback((turnId: number, text: string) => {
    if (imageByTurn[turnId]) return;
    setImagePending((prev) => {
      if (prev.has(turnId)) return prev;
      const next = new Set(prev);
      next.add(turnId);
      return next;
    });
    fetch("/api/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, style: imageStyle }),
    })
      .then(async (res) => {
        if (res.ok) return res.blob();
        const detail = await res.text().catch(() => "");
        throw new Error(`image ${res.status}${detail ? `: ${detail}` : ""}`);
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        setImageByTurn((prev) => ({ ...prev, [turnId]: url }));
      })
      .catch((err) => {
        console.warn("[image]", err);
        if (String(err?.message ?? err).includes("GEMINI_API_KEY")) {
          setGeminiUnavailable(true);
        }
      })
      .finally(() => {
        setImagePending((prev) => {
          if (!prev.has(turnId)) return prev;
          const next = new Set(prev);
          next.delete(turnId);
          return next;
        });
      });
  }, [imageByTurn, imageStyle]);

  const toggleImages = useCallback(() => {
    const next = !imagesOn;
    setImagesOn(next);
    try { localStorage.setItem("imagesOn", next ? "1" : "0"); } catch {}
  }, [imagesOn]);

  const changeImageStyle = useCallback((style: string) => {
    setImageStyle(style);
    try { localStorage.setItem("imageStyle", style); } catch {}
  }, []);

  const renderTurn = useCallback((turnId: number, text: string) => {
    if (!narrationOn) return;
    if (!selectedVoice) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    wsRef.current?.send(JSON.stringify({
      type: "render-audio",
      turnId,
      text: trimmed,
      voice: selectedVoice,
    }));
  }, [narrationOn, selectedVoice]);

  const handleSpeaker = useCallback((turn: AnyTurn) => {
    const pc = playbackRef.current;
    if (!pc) return;
    const id = turn.id;
    if (playbackState.state === "playing" && playbackState.currentTurnId === id) {
      pc.pause();
      return;
    }
    if (playbackState.state === "paused" && playbackState.currentTurnId === id) {
      pc.resume();
      return;
    }
    const url = audioByTurn[id];
    if (url) {
      pc.play(id, url);
      return;
    }
    const text = narratableText(turn);
    if (text) {
      setRenderPending((prev) => new Set(prev).add(id));
      renderTurn(id, text);
    }
  }, [playbackState, audioByTurn, renderTurn]);

  const toggleNarration = useCallback(async () => {
    const next = !narrationOn;
    setNarrationOn(next);
    try { localStorage.setItem("narrationOn", next ? "1" : "0"); } catch {}
    playbackRef.current?.setEnabled(next);
  }, [narrationOn]);

  const changeVoice = useCallback((voice: string) => {
    playbackRef.current?.setVoice(voice);
    setSelectedVoice(voice);
    try { localStorage.setItem("narrationVoice", voice); } catch {}
    setAudioByTurn({});  // old cached URLs were for the old voice
    setRenderPending(new Set());
  }, []);

  // One-time toast the first time we detect Gemini is unavailable.
  useEffect(() => {
    if (!geminiUnavailable) return;
    setToast({
      kind: "blocked",
      text: "Narration and per-turn images are disabled — set GEMINI_API_KEY in .env to enable.",
      id: Date.now(),
    });
  }, [geminiUnavailable]);

  const changeVolume = useCallback((next: number) => {
    setVolume(next);
    try { localStorage.setItem("narrationVolume", String(next)); } catch {}
  }, []);

  useEffect(() => {
    playbackRef.current?.setVolume(volume);
  }, [volume]);

  const wsRef = useRef<WebSocket | null>(null);
  const nextIdRef = useRef(1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastSubmittedRef = useRef<string>("");
  const optimisticTurnIdRef = useRef<number | null>(null);

  const addTurn = useCallback((t: AnyTurn) => {
    setTurns((prev) => [...prev, t]);
  }, []);

  const updateLastInputTurn = useCallback((updater: (t: Turn) => Turn) => {
    setTurns((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        const t = copy[i];
        if (!isSystemTurn(t)) {
          copy[i] = updater(t);
          break;
        }
      }
      return copy;
    });
  }, []);

  // WebSocket lifecycle
  useEffect(() => {
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: "hello" }));
    });

    ws.addEventListener("close", () => {
      setConnected(false);
      setPending(false);
    });

    ws.addEventListener("message", (event) => {
      const msg: ServerMessage = JSON.parse(event.data);
      if (msg.type === "snapshot") {
        setStack({
          turn: msg.turn,
          entries: msg.entries,
          threads: msg.threads,
          objectives: msg.objectives,
          presetSlug: msg.presetSlug,
          position: msg.position,
        });
        setPresets(msg.presets);
        if (msg.providers) setProviders(msg.providers);
        // Surface the briefing whenever a preset run is loaded — survives reloads.
        if (msg.presetSlug !== null) {
          const p = msg.presets.find((x) => x.slug === msg.presetSlug);
          if (p) {
            nextIdRef.current = 1;
            setTurns([{
              id: nextIdRef.current++,
              kind: "system",
              title: p.title,
              items: [p.body],
              variant: "briefing",
            }]);
          }
        }
        return;
      }
      if (msg.type === "move-blocked") {
        setInputValue(lastSubmittedRef.current);
        setToast({
          kind: "blocked",
          text: "Cardinal directions only — try north, south, east, or west.",
          id: Date.now(),
        });
        // Replace the optimistic input turn with the blocked system block.
        if (optimisticTurnIdRef.current !== null) {
          const removeId = optimisticTurnIdRef.current;
          setTurns((prev) => prev.filter((t) => t.id !== removeId));
          optimisticTurnIdRef.current = null;
          setPending(false);
        }
        addTurn({
          id: nextIdRef.current++,
          kind: "system",
          title: `blocked: "${msg.input}"`,
          items: ["needs a cardinal direction — north, south, east, or west"],
          variant: "blocked",
        });
        return;
      }
      if (msg.type === "turn-start") {
        // Client-side send() adds the optimistic turn now; this message is
        // reconciliation. Fall back to the legacy path only if no optimistic
        // turn exists (server-initiated turn or unexpected ordering).
        if (optimisticTurnIdRef.current === null) {
          const tid = nextIdRef.current++;
          addTurn({ id: tid, input: msg.input, pending: true });
          setPending(true);
        }
        return;
      }
      if (msg.type === "narrative") {
        updateLastInputTurn((t) => ({ ...t, narrative: msg.text }));
        return;
      }
      if (msg.type === "stack-update") {
        setStack((s) => {
          const flips = diffAchievedTexts(s.objectives, msg.objectives);
          if (flips.length > 0) {
            // Defer the addTurn to the next tick to avoid setState-during-setState.
            queueMicrotask(() => {
              for (const text of flips) {
                addTurn({
                  id: nextIdRef.current++,
                  kind: "system",
                  title: "✓ Objective complete",
                  items: [text],
                });
              }
            });
          }
          const newEntries = diffNewItems(s.entries, msg.entries);
          const newThreads = diffNewItems(s.threads, msg.threads);
          const toastEntries = newEntries.length > 0 && entriesCollapsedRef.current ? newEntries : [];
          const toastThreads = newThreads.length > 0 && threadsCollapsedRef.current ? newThreads : [];
          if (toastEntries.length > 0 || toastThreads.length > 0) {
            queueMicrotask(() => {
              setToast({ kind: "world-update", entries: toastEntries, threads: toastThreads, id: Date.now() });
            });
          }
          return {
            ...s,
            entries: msg.entries,
            threads: msg.threads,
            objectives: msg.objectives,
            turn: s.turn + 1,
            position: msg.position,
          };
        });
        updateLastInputTurn((t) => ({ ...t, pending: false }));
        setPending(false);
        optimisticTurnIdRef.current = null;
        return;
      }
      if (msg.type === "win") {
        setModal("win");
        return;
      }
      if (msg.type === "audio-ready") {
        setAudioByTurn((prev) => ({ ...prev, [msg.turnId]: msg.url }));
        setRenderPending((prev) => {
          if (!prev.has(msg.turnId)) return prev;
          const next = new Set(prev);
          next.delete(msg.turnId);
          return next;
        });
        if (narrationOnRef.current) {
          playbackRef.current?.play(msg.turnId, msg.url);
        }
        return;
      }
      if (msg.type === "audio-error") {
        setRenderPending((prev) => {
          if (!prev.has(msg.turnId)) return prev;
          const next = new Set(prev);
          next.delete(msg.turnId);
          return next;
        });
        // Log it, but don't break the turn — the narrative is already on screen.
        console.warn("[narration]", msg.message);
        return;
      }
      if (msg.type === "debug-trace") {
        setLastTrace(msg.trace);
        return;
      }
      if (msg.type === "error") {
        updateLastInputTurn((t) => ({
          ...t,
          pending: false,
          error: `${msg.source} error: ${msg.message}`,
        }));
        setPending(false);
        optimisticTurnIdRef.current = null;
        return;
      }
    });

    return () => {
      ws.close();
    };
  }, [addTurn, updateLastInputTurn]);

  // Auto-scroll to end of document on new turn or when an image lands
  useEffect(() => {
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
    });
  }, [turns, imageByTurn]);

  // Auto-render narration audio when narrationOn and a turn has narrative but no audio yet.
  // Using useEffect (not inline in the WS handler) avoids stale-closure bugs: narrationOn
  // is always current here because this effect re-runs whenever either turns or narrationOn changes.
  // Auto-generate image for the latest narrative turn when imagesOn.
  // Mirrors the audio auto-render: walk newest-first, kick off the most recent
  // un-imaged regular turn. System briefings don't auto-image (no manual button there either).
  useEffect(() => {
    if (!imagesOn || geminiUnavailable) return;
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (!t || isSystemTurn(t)) continue;
      if (t.narrative && !(t.id in imageByTurn) && !imagePending.has(t.id)) {
        renderImage(t.id, t.narrative);
        break;
      }
    }
  }, [turns, imagesOn, imageByTurn, imagePending, renderImage, geminiUnavailable]);

  // Auto-render briefing audio when narrationOn and the most recent briefing has no cached audio yet.
  // Walks newest-first and breaks on the first briefing — mirrors the audio auto-render strategy
  // (feedback_auto_render_only_latest) so we never queue duplicate renders.
  useEffect(() => {
    if (!narrationOn) return;
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (!t) continue;
      if (!isSystemTurn(t) || t.variant !== "briefing") continue;
      if (t.id in audioByTurn) break;
      if (renderPending.has(t.id)) break;
      const text = narratableText(t);
      if (text) {
        setRenderPending((prev) => new Set(prev).add(t.id));
        renderTurn(t.id, text);
      }
      break;
    }
  }, [turns, narrationOn, audioByTurn, renderPending, renderTurn]);

  // Restore focus to the input when it becomes interactive again
  useEffect(() => {
    if (!pending && connected) inputRef.current?.focus();
  }, [pending, connected]);

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const slash = parseSlashCommand(trimmed);
    if (slash) {
      if (slash.name === "debug") {
        setModal("debug");
        return;
      }
      if (slash.name === "gallery") {
        setModal("gallery");
        return;
      }
      setToast({ kind: "blocked", text: `unknown command: /${slash.name}`, id: Date.now() });
      return;
    }

    if (!wsRef.current || pending) return;

    const lower = trimmed.toLowerCase();

    // Client-side system commands (no LLM round-trip)
    if (lower === "stack") {
      addTurn({
        id: nextIdRef.current++,
        kind: "system",
        title: `World state — turn ${stack.turn}`,
        items: stack.entries.length > 0 ? stack.entries : ["(empty)"],
      });
      return;
    }
    if (lower === "threads") {
      addTurn({
        id: nextIdRef.current++,
        kind: "system",
        title: `Active threads — turn ${stack.turn}`,
        items: stack.threads.length > 0 ? stack.threads : ["(no active threads)"],
        variant: "threads",
      });
      return;
    }
    if (lower === "help") {
      addTurn({
        id: nextIdRef.current++,
        kind: "system",
        title: "Commands",
        items: [
          "stack       show world state",
          "threads     show active threads",
          "help        this list",
          "(or type any action — use the new game button to switch stories)",
        ],
      });
      return;
    }
    // Optimistically render the input echo + pending indicator before the
    // server's interpreter call completes. Server's turn-start becomes a no-op
    // when this ref is set; move-blocked removes the optimistic turn.
    const tid = nextIdRef.current++;
    addTurn({ id: tid, input: trimmed, pending: true });
    setPending(true);
    optimisticTurnIdRef.current = tid;

    wsRef.current.send(JSON.stringify({
      type: "input",
      text: trimmed,
      ...(narrationOn ? { voice: selectedVoice || providers?.voices?.[0] || "noir" } : {}),
    }));
  }, [addTurn, pending, stack, narrationOn, selectedVoice, providers]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    lastSubmittedRef.current = inputValue;
    send(inputValue);
    setInputValue("");
  }, [send, inputValue]);

  const activePreset = stack.presetSlug
    ? presets.find((p) => p.slug === stack.presetSlug)
    : null;
  const presetTitle = activePreset?.title ?? null;
  const hasObjectives = stack.objectives.length > 0;
  const hasWorldState = stack.entries.length > 0 || stack.threads.length > 0;

  const startGame = useCallback((slug: string | null) => {
    playbackRef.current?.abortCurrent();
    wsRef.current?.send(JSON.stringify({ type: "start", presetSlug: slug }));
    setTurns([]);
    nextIdRef.current = 1;
    setAudioByTurn({});
    Object.values(imageByTurn).forEach(URL.revokeObjectURL);
    setImageByTurn({});
    setHasStarted(true);
    setModal(null);
  }, [imageByTurn]);

  const resumeGame = useCallback(() => {
    setHasStarted(true);
  }, []);

  const savedGame: { title: string; turn: number; isEmpty: boolean } | null = (() => {
    if (stack.presetSlug !== null) {
      const p = presets.find((x) => x.slug === stack.presetSlug);
      return p ? { title: p.title, turn: stack.turn, isEmpty: false } : null;
    }
    if (stack.turn > 0 || stack.entries.length > 0) {
      return { title: "Empty world", turn: stack.turn, isEmpty: true };
    }
    return null;
  })();

  if (!hasStarted) {
    return (
      <TitlePage
        presets={presets}
        onPick={startGame}
        onResume={resumeGame}
        savedGame={savedGame}
        connected={connected}
      />
    );
  }

  return (
    <>
      <audio ref={(el) => playbackRef.current?.attachElement(el)} preload="auto" />
      <div className="page">
        <header className="masthead">
          <div className="app-header">World Engine</div>
          <div className={`connection-status ${connected ? "connected" : ""}`}>
            {connected ? "Connected" : "Connecting…"}
          </div>
        </header>

        <div className="dashboard">
          <aside
            className={`rail rail-left ${hasObjectives || hasWorldState ? "" : "rail-empty"}`}
          >
            {hasObjectives && (
              <ObjectivesRail
                title={presetTitle ?? "Objectives"}
                objectives={stack.objectives}
                turn={stack.turn}
                position={null}
              />
            )}
            {hasWorldState && (
              <WorldRail
                entries={stack.entries}
                threads={stack.threads}
                entriesCollapsed={entriesCollapsed}
                toggleEntries={toggleEntries}
                threadsCollapsed={threadsCollapsed}
                toggleThreads={toggleThreads}
              />
            )}
          </aside>

          <main className="reading">
            <div className="turn-list">
              {turns.map((t) => (isSystemTurn(t) ? (
                <SystemBlock
                  key={t.id}
                  turn={t}
                  audioUrl={audioByTurn[t.id]}
                  bannerUrl={
                    t.variant === "briefing" && activePreset?.hasBanner
                      ? `/api/preset-banner/${stack.presetSlug}`
                      : undefined
                  }
                  isPlaying={playbackState.state === "playing" && playbackState.currentTurnId === t.id}
                  isPaused={playbackState.state === "paused" && playbackState.currentTurnId === t.id}
                  onSpeaker={() => handleSpeaker(t)}
                />
              ) : (
                <TurnBlock
                  key={t.id}
                  turn={t}
                  audioUrl={audioByTurn[t.id]}
                  isPlaying={playbackState.state === "playing" && playbackState.currentTurnId === t.id}
                  isPaused={playbackState.state === "paused" && playbackState.currentTurnId === t.id}
                  onSpeaker={() => handleSpeaker(t)}
                  imageUrl={imageByTurn[t.id]}
                  imagePending={imagePending.has(t.id)}
                  onGenerateImage={t.narrative ? () => renderImage(t.id, t.narrative!) : undefined}
                  onZoomImage={setLightbox}
                />
              )))}
            </div>
          </main>
        </div>
        {toast && <Toast data={toast} onDismiss={() => setToast(null)} />}
      </div>

      <div className="action-bar">
        <div className="action-bar-inner">
          <form className="input-row" onSubmit={handleSubmit}>
            <span className="input-prompt">&gt;</span>
            <input
              ref={inputRef}
              className="input-field"
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={pending ? "the world is responding…" : "what do you do?"}
              disabled={pending || !connected}
              autoFocus
            />
          </form>
          <div className="button-row">
            <div className="actions-menu" ref={actionsMenuRef}>
              <button
                className="action-button"
                onClick={() => setActionsOpen((o) => !o)}
                disabled={pending || !connected}
                aria-expanded={actionsOpen}
                aria-haspopup="menu"
                title="quick actions"
              >
                actions {actionsOpen ? "▾" : "▸"}
              </button>
              {actionsOpen && (
                <div className="actions-popover" role="menu">
                  {QUICK_ACTIONS.map((a) => (
                    <button
                      key={a}
                      className="action-button"
                      onClick={() => { send(a); setActionsOpen(false); }}
                      disabled={pending || !connected}
                      role="menuitem"
                    >
                      {a}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="button-row-spacer" />
            <div className="split-button">
              <button
                className={`action-button split-face ${narrationOn ? "critical" : ""}`}
                onClick={() => { if (providers?.useNarration && providers?.narrationReady) toggleNarration(); }}
                disabled={!connected || !(providers?.useNarration && providers?.narrationReady)}
                aria-disabled={!(providers?.useNarration && providers?.narrationReady)}
                title={
                  !providers?.useNarration
                    ? "USE_NARRATION=false in .env"
                    : !providers?.narrationReady
                      ? "Narration warming up..."
                      : "toggle narration"
                }
              >
                voice {narrationOn ? "on" : "off"}
              </button>
              <button
                className={`action-button split-arrow ${narrationOn ? "critical" : ""}`}
                onClick={() => { if (providers?.useNarration && providers?.narrationReady) setModal("voice"); }}
                disabled={!connected || !(providers?.useNarration && providers?.narrationReady)}
                aria-disabled={!(providers?.useNarration && providers?.narrationReady)}
                title={
                  !providers?.useNarration
                    ? "USE_NARRATION=false in .env"
                    : !providers?.narrationReady
                      ? "Narration warming up..."
                      : "narration settings"
                }
                aria-label="narration settings"
              >
                ▾
              </button>
            </div>
            <div className="split-button">
              <button
                className={`action-button split-face ${imagesOn ? "critical" : ""}`}
                onClick={() => { if (providers?.useGeminiImages) toggleImages(); }}
                disabled={!connected || !providers?.useGeminiImages}
                aria-disabled={!providers?.useGeminiImages}
                title={
                  !providers?.useGeminiImages
                    ? "USE_GEMINI_IMAGES=false in .env"
                    : "auto-generate an image for each new turn"
                }
              >
                images {imagesOn ? "on" : "off"}
              </button>
              <button
                className={`action-button split-arrow ${imagesOn ? "critical" : ""}`}
                onClick={() => { if (providers?.useGeminiImages) setModal("image"); }}
                disabled={!connected || !providers?.useGeminiImages}
                aria-disabled={!providers?.useGeminiImages}
                title={
                  !providers?.useGeminiImages
                    ? "USE_GEMINI_IMAGES=false in .env"
                    : "image settings"
                }
                aria-label="image settings"
              >
                ▾
              </button>
            </div>
            <div className="split-button">
              <button
                className="action-button split-face info"
                onClick={() => send("inventory")}
                disabled={pending || !connected}
                title="ask the world about your inventory"
              >
                inventory
              </button>
              <button
                className="action-button split-arrow info"
                onClick={() => setModal("inventory")}
                disabled={!connected}
                title="open inventory panel"
                aria-label="open inventory panel"
              >
                ▾
              </button>
            </div>
          </div>
        </div>
      </div>

      {modal !== null && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className={`modal${modal === "gallery" ? " modal-wide" : ""}`} onClick={(e) => e.stopPropagation()}>
            {modal === "select" && (
              <SelectView
                presets={presets}
                onPick={startGame}
                onCancel={() => setModal(null)}
              />
            )}
            {modal === "win" && (
              <WinView
                objectives={stack.objectives}
                onKeepExploring={() => {
                  wsRef.current?.send(JSON.stringify({ type: "keep-exploring" }));
                  setModal(null);
                }}
                onNewGame={() => setModal("select")}
              />
            )}
            {modal === "voice" && (
              <VoiceView
                voices={voices}
                selectedVoice={selectedVoice}
                onPickVoice={changeVoice}
                volume={volume}
                onChangeVolume={changeVolume}
                onClose={() => setModal(null)}
              />
            )}
            {modal === "image" && (
              <ImageView
                styles={IMAGE_STYLES}
                selected={imageStyle}
                onPick={changeImageStyle}
                onClose={() => setModal(null)}
              />
            )}
            {modal === "inventory" && (
              <>
                <div className="modal-body">
                  <div className="modal-title">Inventory</div>
                  <p className="turn-narrative">First-class inventory panel coming soon. For now, click <strong>inventory</strong> directly to ask the world what you're carrying.</p>
                </div>
                <button className="action-button" onClick={() => setModal(null)}>close</button>
              </>
            )}
            {modal === "debug" && (
              <DebugModal
                stack={stack}
                position={stack.position}
                placeDescription={lastTrace?.archivist?.locationDescription}
                providers={providers}
                lastTrace={lastTrace}
                onClose={() => setModal(null)}
              />
            )}
            {modal === "gallery" && (
              <GalleryModal onClose={() => setModal(null)} onZoom={setLightbox} />
            )}
          </div>
        </div>
      )}
      {lightbox && <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}

function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }): React.ReactElement {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <img src={src} alt="" className="lightbox-image" onClick={(e) => e.stopPropagation()} />
      <button className="lightbox-close" onClick={onClose} aria-label="Close">✕</button>
    </div>
  );
}

function SaveToGalleryButton({ imageUrl }: { imageUrl: string }): React.ReactElement {
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const save = useCallback(async () => {
    if (status === "saving" || status === "saved") return;
    setStatus("saving");
    try {
      const blobRes = await fetch(imageUrl);
      const blob = await blobRes.blob();
      const res = await fetch("/api/media/save", {
        method: "POST",
        headers: { "Content-Type": blob.type || "image/png" },
        body: blob,
      });
      if (!res.ok) throw new Error(`save failed: ${res.status}`);
      setStatus("saved");
    } catch (err) {
      console.warn("[save-to-gallery]", err);
      setStatus("error");
      setTimeout(() => setStatus("idle"), 2500);
    }
  }, [imageUrl, status]);

  const label =
    status === "saving" ? "Saving…" :
    status === "saved" ? "Saved to gallery" :
    status === "error" ? "Save failed — click to retry" :
    "Save to gallery";
  const glyph =
    status === "saving" ? "◌" :
    status === "saved" ? "✓" :
    status === "error" ? "!" :
    "★";

  return (
    <button
      type="button"
      className={`turn-image-btn ${status === "saved" ? "ready" : ""} ${status === "saving" ? "pending" : ""}`}
      onClick={save}
      disabled={status === "saving" || status === "saved"}
      title={label}
      aria-label={label}
    >
      {glyph}
    </button>
  );
}

interface MediaItem { name: string; mtime: number }

function GalleryModal({ onClose, onZoom }: { onClose: () => void; onZoom?: (url: string) => void }): React.ReactElement {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/media")
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))
      .then((data: { items: MediaItem[] }) => {
        if (cancelled) return;
        setItems(data.items);
      })
      .catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, []);

  const prev = useCallback(() => {
    setIdx((i) => (items && items.length ? (i - 1 + items.length) % items.length : 0));
  }, [items]);
  const next = useCallback(() => {
    setIdx((i) => (items && items.length ? (i + 1) % items.length : 0));
  }, [items]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, prev, next]);

  // Keep the selected thumbnail visible in the strip.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const thumb = strip.querySelector<HTMLElement>(`[data-idx="${idx}"]`);
    if (thumb) thumb.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [idx]);

  const current = items && items.length > 0 ? items[idx] : null;
  return (
    <div className="gallery-modal">
      <div className="gallery-header">
        <h3>Gallery {items ? `(${items.length})` : ""}</h3>
        <button className="action-button" onClick={onClose}>close</button>
      </div>
      {error && <p className="debug-error">failed to load: {error}</p>}
      {!items && !error && <p className="debug-muted">loading…</p>}
      {items && items.length === 0 && <p className="debug-muted">no images in media/</p>}
      {current && (
        <>
          <div className="gallery-main">
            <button className="gallery-arrow" onClick={prev} aria-label="previous">◀</button>
            <img
              src={`/media/${current.name}`}
              alt={current.name}
              className="gallery-image"
              onClick={onZoom ? () => onZoom(`/media/${current.name}`) : undefined}
              style={onZoom ? { cursor: "zoom-in" } : undefined}
            />
            <button className="gallery-arrow" onClick={next} aria-label="next">▶</button>
          </div>
          <div className="gallery-caption">{current.name}</div>
          <div className="gallery-strip" ref={stripRef}>
            {(items ?? []).map((it, i) => (
              <img
                key={it.name}
                data-idx={i}
                src={`/media/${it.name}`}
                alt={it.name}
                className={`gallery-thumb${i === idx ? " gallery-thumb-active" : ""}`}
                onClick={() => setIdx(i)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TurnBlock({ turn, audioUrl, isPlaying, isPaused, onSpeaker, imageUrl, imagePending, onGenerateImage, onZoomImage }: {
  turn: Turn;
  audioUrl?: string;
  isPlaying?: boolean;
  isPaused?: boolean;
  onSpeaker: () => void;
  imageUrl?: string;
  imagePending?: boolean;
  onGenerateImage?: () => void;
  onZoomImage?: (url: string) => void;
}) {
  const num = String(turn.id).padStart(2, "0");

  return (
    <div className="turn-block">
      <div className="turn-margin">
        <span aria-hidden="true">{num}</span>
        {turn.narrative && (
          <button
            type="button"
            className={`turn-speaker ${audioUrl ? "ready" : ""} ${isPlaying ? "audible" : ""} ${isPaused ? "paused" : ""}`}
            onClick={onSpeaker}
            title={isPlaying ? "Pause" : isPaused ? "Resume" : audioUrl ? "Play" : "Generate"}
            aria-label={isPlaying ? "Pause narration" : isPaused ? "Resume narration" : audioUrl ? "Play narration" : "Generate narration"}
          >
            {isPlaying ? "❚❚" : isPaused ? "▶" : "◐"}
          </button>
        )}
        {turn.narrative && onGenerateImage && (
          <button
            type="button"
            className={`turn-image-btn ${imageUrl ? "ready" : ""} ${imagePending ? "pending" : ""}`}
            onClick={onGenerateImage}
            disabled={imagePending || !!imageUrl}
            title={imageUrl ? "Image generated" : imagePending ? "Generating…" : "Generate image"}
            aria-label={imageUrl ? "Image generated" : imagePending ? "Generating image" : "Generate image"}
          >
            {imagePending ? "◌" : "▦"}
          </button>
        )}
        {imageUrl && <SaveToGalleryButton imageUrl={imageUrl} />}
      </div>
      <div className="turn-content">
        <p className="turn-input-echo">{turn.input}</p>
        {imageUrl && (
          <img
            className="turn-image"
            src={imageUrl}
            alt=""
            onClick={onZoomImage ? () => onZoomImage(imageUrl) : undefined}
            style={onZoomImage ? { cursor: "zoom-in" } : undefined}
          />
        )}
        {turn.narrative && <p className="turn-narrative">{turn.narrative}</p>}
        {turn.pending && !turn.narrative && !turn.error && (
          <p className="turn-pending">the world is responding…</p>
        )}
        {turn.error && <p className="turn-error">{turn.error}</p>}
      </div>
    </div>
  );
}

function SystemBlock({ turn, audioUrl, bannerUrl, isPlaying, isPaused, onSpeaker }: {
  turn: SystemTurn;
  audioUrl?: string;
  bannerUrl?: string;
  isPlaying?: boolean;
  isPaused?: boolean;
  onSpeaker?: () => void;
}) {
  const isBriefing = turn.variant === "briefing";
  if (isBriefing) {
    return (
      <div className="turn-block briefing-turn">
        <div className="turn-margin">
          <span aria-hidden="true">00</span>
          {onSpeaker && (
            <button
              type="button"
              className={`turn-speaker ${audioUrl ? "ready" : ""} ${isPlaying ? "audible" : ""} ${isPaused ? "paused" : ""}`}
              onClick={onSpeaker}
              aria-label={isPlaying ? "Pause narration" : isPaused ? "Resume narration" : audioUrl ? "Play narration" : "Generate narration"}
              title={isPlaying ? "Pause" : isPaused ? "Resume" : audioUrl ? "Play" : "Generate"}
            >
              {isPlaying ? "❚❚" : isPaused ? "▶" : "◐"}
            </button>
          )}
        </div>
        <div className="turn-content">
          {bannerUrl && (
            <img className="briefing-banner" src={bannerUrl} alt="" />
          )}
          {turn.items.map((item, idx) => (
            <p key={idx} className="turn-narrative">{item}</p>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className={`turn-block system ${turn.variant || ""}`}>
      <div className="turn-content">
        <div className="turn-header">{turn.title}</div>
        <ul className={`system-list ${turn.variant || ""}`}>
          {turn.items.map((item, idx) => (
            <li key={idx}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function SelectView(props: {
  presets: PresetSummary[];
  onPick: (slug: string | null) => void;
  onCancel: () => void;
}) {
  const { presets, onPick, onCancel } = props;
  const surprise = () => {
    if (presets.length === 0) return;
    const p = presets[Math.floor(Math.random() * presets.length)];
    if (p) onPick(p.slug);
  };
  return (
    <>
      <div className="modal-body">
        <div className="modal-title">Start a new story</div>
        <div className="preset-row" onClick={surprise}>
          <span className="title">Surprise me</span>
          <span className="description">a random opening</span>
        </div>
        {presets.map((p) => (
          <div key={p.slug} className="preset-row" onClick={() => onPick(p.slug)}>
            <span className="title">{p.title}</span>
            <span className="description">{p.description}</span>
          </div>
        ))}
        <div className="modal-divider" />
        <div className="preset-row" onClick={() => onPick(null)}>
          <span className="title">Empty world</span>
          <span className="description">No preset — make your own way.</span>
        </div>
      </div>
      <button className="action-button" onClick={onCancel}>cancel</button>
    </>
  );
}

function TitlePage(props: {
  presets: PresetSummary[];
  onPick: (slug: string | null) => void;
  onResume: () => void;
  savedGame: { title: string; turn: number; isEmpty: boolean } | null;
  connected: boolean;
}) {
  const { presets, onPick, onResume, savedGame, connected } = props;
  const surprise = () => {
    if (presets.length === 0) return;
    const p = presets[Math.floor(Math.random() * presets.length)];
    if (p) onPick(p.slug);
  };
  return (
    <main className="title-page">
      <div className="title-page-inner">
        <span className="title-eyebrow">World Engine · Text adventure</span>
        <h1 className="title-page-title">Pick a world,<br />make it move.</h1>
        <p className="title-page-subtitle">
          A model writes the room. You decide what happens next. Choose a starting
          situation or open an empty world and shape it from the first sentence.
        </p>

        {savedGame && (
          <button type="button" className="continue-card" onClick={onResume}>
            <div className="continue-card-meta">
              <span className="continue-card-eyebrow">Continue</span>
              <span className="continue-card-title">{savedGame.title}</span>
              <span className="continue-card-sub">
                {savedGame.isEmpty ? "Empty world" : "In progress"} · Turn {savedGame.turn}
              </span>
            </div>
            <span className="continue-card-cta">Resume</span>
          </button>
        )}

        <div className="title-section-label">{savedGame ? "Or start a new story" : "Stories"}</div>

        <div className="story-grid">
          <button type="button" className="story-card surprise" onClick={surprise}>
            <span className="story-card-tag">Random</span>
            <h3 className="story-card-title">Surprise me</h3>
            <p className="story-card-desc">Pick a starting situation at random and dive in.</p>
          </button>
          {presets.map((p) => (
            <button
              type="button"
              key={p.slug}
              className="story-card"
              onClick={() => onPick(p.slug)}
            >
              <h3 className="story-card-title">{p.title}</h3>
              <p className="story-card-desc">{p.description}</p>
            </button>
          ))}
        </div>

        <button type="button" className="empty-world-row" onClick={() => onPick(null)}>
          <span className="label">Empty world</span>
          <span className="desc">No preset — make your own way</span>
        </button>

        <div className="title-page-footer">
          <span>{presets.length} {presets.length === 1 ? "story" : "stories"} loaded</span>
          <span className={`connection-status ${connected ? "connected" : ""}`}>
            {connected ? "Connected" : "Connecting…"}
          </span>
        </div>
      </div>
    </main>
  );
}

function ObjectivesList({ objectives }: { objectives: Objective[] }) {
  return (
    <ul className="rail-objectives">
      {objectives.map((o, i) => (
        <li key={i} className={`rail-objective ${o.achieved ? "achieved" : ""}`}>
          <span className="rail-objective-mark" aria-hidden />
          <span className="rail-objective-text">{o.text}</span>
        </li>
      ))}
    </ul>
  );
}

function VoiceView(props: {
  voices: string[];
  selectedVoice: string;
  onPickVoice: (voice: string) => void;
  volume: number;
  onChangeVolume: (next: number) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="modal-body">
        <div className="modal-title">Narration settings</div>

        {props.voices.length > 1 && (
          <div className="voice-row">
            <label className="voice-row-label">Voice</label>
            <select
              className="voice-select"
              value={props.selectedVoice}
              onChange={(e) => props.onPickVoice(e.target.value)}
            >
              {props.voices.map((v) => (
                <option key={v} value={v}>
                  {v.replace(/^en_..-/, "").replace(/-medium$|-high$/, "")}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="voice-row">
          <label className="voice-row-label">
            Volume <span className="voice-row-value">{Math.round(props.volume * 100)}%</span>
          </label>
          <div className="voice-slider-wrap">
            <span className="voice-slider-end">0</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={props.volume}
              onChange={(e) => props.onChangeVolume(parseFloat(e.target.value))}
            />
            <span className="voice-slider-end">100</span>
          </div>
          <div className="voice-row-hint">Adjusts playback live.</div>
        </div>
      </div>
      <button className="action-button" onClick={props.onClose}>done</button>
    </>
  );
}

function ImageView(props: {
  styles: string[];
  selected: string;
  onPick: (style: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="modal-body">
        <div className="modal-title">Image settings</div>
        <div className="voice-row">
          <label className="voice-row-label">Style</label>
          <select
            className="voice-select"
            value={props.selected}
            onChange={(e) => props.onPick(e.target.value)}
          >
            {props.styles.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <div className="voice-row-hint">Applied to images generated next.</div>
        </div>
      </div>
      <button className="action-button" onClick={props.onClose}>done</button>
    </>
  );
}

function WinView(props: {
  objectives: Objective[];
  onKeepExploring: () => void;
  onNewGame: () => void;
}) {
  return (
    <>
      <div className="modal-body">
        <div className="modal-title">Mission complete</div>
        <ObjectivesList objectives={props.objectives} />
      </div>
      <button className="action-button" onClick={props.onKeepExploring}>keep exploring</button>
      <button className="action-button critical" onClick={props.onNewGame}>new game</button>
    </>
  );
}

function DebugModal(props: {
  stack: Stack;
  position: Position;
  placeDescription?: string;
  providers: ProviderInfo | null;
  lastTrace: LastTurnTrace | null;
  onClose: () => void;
}) {
  const { stack, position, placeDescription, providers, lastTrace, onClose } = props;
  const active = stack.objectives.filter(
    (o) => !o.position || (o.position[0] === position[0] && o.position[1] === position[1])
  );
  const distant = stack.objectives.filter(
    (o) => o.position && (o.position[0] !== position[0] || o.position[1] !== position[1])
  );
  return (
    <div className="modal-body debug-modal">
      <div className="modal-title">Debug</div>
      <div className="debug-columns">
        <section className="debug-col">
          <h4>Live state</h4>
          <p><strong>Position</strong> [{position[0]}, {position[1]}] (key: {position[0]},{position[1]})</p>
          {placeDescription && (
            <p><strong>Place</strong> {placeDescription}</p>
          )}
          <p><strong>Turn</strong> {stack.turn}</p>
          <p><strong>Preset</strong> {stack.presetSlug ?? "(free play)"}</p>

          <h5>Objectives — active here ({active.length})</h5>
          {active.length === 0 ? (
            <p className="debug-muted">(none)</p>
          ) : (
            <ul>{active.map((o, i) => (
              <li key={i}>{o.achieved ? "✓" : "·"} {o.text}{o.position ? ` @ [${o.position[0]},${o.position[1]}]` : ""}</li>
            ))}</ul>
          )}

          <h5>Objectives — distant ({distant.length})</h5>
          {distant.length === 0 ? (
            <p className="debug-muted">(none)</p>
          ) : (
            <ul>{distant.map((o, i) => (
              <li key={i}>{o.achieved ? "✓" : "·"} {o.text} @ [{o.position![0]},{o.position![1]}]</li>
            ))}</ul>
          )}

          <h5>Entries ({stack.entries.length})</h5>
          {stack.entries.length === 0 ? (
            <p className="debug-muted">(none)</p>
          ) : (
            <ul>{stack.entries.map((e, i) => <li key={i}>{e}</li>)}</ul>
          )}

          <h5>Threads ({stack.threads.length})</h5>
          {stack.threads.length === 0 ? (
            <p className="debug-muted">(none)</p>
          ) : (
            <ul>{stack.threads.map((t, i) => <li key={i}>{t}</li>)}</ul>
          )}

          <h5>Providers</h5>
          {providers ? (
            <ul>
              <li>narrator: {providers.narrator.provider} / {providers.narrator.model}</li>
              <li>archivist: local / {providers.archivist.model}</li>
              <li>interpreter: {providers.interpreter.provider} / {providers.interpreter.model}</li>
              <li>tts: {providers.tts.provider} / {providers.tts.voice}</li>
              <li>image: {providers.image.provider} / {providers.image.style}</li>
            </ul>
          ) : (
            <p className="debug-muted">(loading)</p>
          )}
        </section>

        <section className="debug-col">
          <h4>Last turn pipeline</h4>
          {!lastTrace ? (
            <p className="debug-muted">No turns yet — play a turn to see pipeline trace.</p>
          ) : (
            <>
              <p><strong>ts</strong> {lastTrace.ts}</p>
              <p><strong>turn</strong> {lastTrace.turn}</p>
              <p><strong>input</strong> {lastTrace.input}</p>

              <h5>Interpreter</h5>
              <ul>
                <li>action: {lastTrace.interpreter.action}</li>
                <li>provider: {lastTrace.interpreter.provider}</li>
              </ul>

              <h5>Archivist</h5>
              {lastTrace.archivist === null ? (
                <p className="debug-muted">(skipped — see error or move-blocked)</p>
              ) : (
                <pre className="debug-json">{JSON.stringify(lastTrace.archivist, null, 2)}</pre>
              )}

              {lastTrace.error && (
                <>
                  <h5>Error</h5>
                  <p className="debug-error">{lastTrace.error.source}: {lastTrace.error.message}</p>
                </>
              )}
            </>
          )}
        </section>
      </div>
      <button className="action-button" onClick={onClose}>close</button>
    </div>
  );
}

function ObjectivesRail(props: {
  title: string;
  objectives: Objective[];
  turn: number;
  position: [number, number] | null;
}) {
  const total = props.objectives.length;
  const done = props.objectives.filter((o) => o.achieved).length;
  return (
    <div className="rail-card">
      <div className="rail-eyebrow">Mission</div>
      <div className="rail-title">{props.title}</div>
      <div className="rail-progress">
        <span className="rail-progress-num">{done}</span>
        <span className="rail-progress-sep"> / </span>
        <span className="rail-progress-total">{total}</span>
        <span className="rail-progress-label"> objectives</span>
      </div>
      <ul className="rail-objectives">
        {props.objectives.map((o, i) => (
          <li
            key={i}
            className={`rail-objective ${o.achieved ? "achieved" : ""}`}
          >
            <span className="rail-objective-mark" aria-hidden />
            <span className="rail-objective-text">{o.text}</span>
          </li>
        ))}
      </ul>
      <div className="rail-meta">
        <span className="rail-meta-label">Turn</span>
        <span className="rail-meta-value">{String(props.turn).padStart(2, "0")}</span>
      </div>
    </div>
  );
}

function useCollapsed(key: string, initial: boolean): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : stored === "1";
    } catch {
      return initial;
    }
  });
  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(key, next ? "1" : "0"); } catch {}
      return next;
    });
  }, [key]);
  return [collapsed, toggle];
}

function WorldRail(props: {
  entries: string[];
  threads: string[];
  entriesCollapsed: boolean;
  toggleEntries: () => void;
  threadsCollapsed: boolean;
  toggleThreads: () => void;
}) {
  return (
    <div className="rail-card">
      {props.entries.length > 0 && (
        <>
          <button
            type="button"
            className="rail-eyebrow rail-eyebrow-toggle"
            onClick={props.toggleEntries}
            aria-expanded={!props.entriesCollapsed}
          >
            <span className="rail-eyebrow-caret" aria-hidden>{props.entriesCollapsed ? "▸" : "▾"}</span>
            <span>Established ({props.entries.length})</span>
          </button>
          {!props.entriesCollapsed && (
            <ul className="rail-entries">
              {props.entries.map((e, i) => (
                <li key={i} className="rail-entry">
                  <span className="rail-entry-mark" aria-hidden>·</span>
                  <span>{e}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {props.threads.length > 0 && (
        <>
          <button
            type="button"
            className="rail-eyebrow rail-eyebrow-secondary rail-eyebrow-toggle"
            onClick={props.toggleThreads}
            aria-expanded={!props.threadsCollapsed}
          >
            <span className="rail-eyebrow-caret" aria-hidden>{props.threadsCollapsed ? "▸" : "▾"}</span>
            <span>Loose threads ({props.threads.length})</span>
          </button>
          {!props.threadsCollapsed && (
            <ul className="rail-threads">
              {props.threads.map((t, i) => (
                <li key={i} className="rail-thread">
                  <span className="rail-thread-mark" aria-hidden>→</span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Toast({ data, onDismiss }: { data: ToastData; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 10_000);
    return () => clearTimeout(timer);
  }, [data.id]);

  if (data.kind === "blocked") {
    return (
      <div className="toast toast-blocked" role="status" aria-live="polite">
        <div className="toast-header">
          <span className="toast-label">Direction needed</span>
        </div>
        <div className="toast-items">
          <div className="toast-item">{data.text}</div>
        </div>
      </div>
    );
  }

  const allItems = [...data.entries, ...data.threads];
  return (
    <div className="toast" role="status" aria-live="polite">
      <div className="toast-header">
        <span className="toast-label">World updated</span>
      </div>
      <div className="toast-items">
        {allItems.map((item, i) => (
          <div key={i} className="toast-item">{item}</div>
        ))}
      </div>
    </div>
  );
}

export function diffAchievedTexts(
  prev: Objective[],
  curr: Objective[]
): string[] {
  const flips: string[] = [];
  const upTo = Math.min(prev.length, curr.length);
  for (let i = 0; i < upTo; i++) {
    const p = prev[i];
    const c = curr[i];
    if (p && c && !p.achieved && c.achieved) {
      flips.push(c.text);
    }
  }
  return flips;
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
