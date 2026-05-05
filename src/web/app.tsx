import React, { useEffect, useRef, useState, useCallback } from "react";
import { TTSEngine, type EngineStatus } from "./tts";
import { createRoot } from "react-dom/client";

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
  variant?: "threads" | "briefing";
};

type AnyTurn = Turn | SystemTurn;

type Objective = { text: string; achieved: boolean };

type PresetSummary = {
  slug: string;
  title: string;
  description: string;
  body: string;
};

type Stack = {
  turn: number;
  entries: string[];
  threads: string[];
  objectives: Objective[];
  presetSlug: string | null;
};

type ServerMessage =
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

const QUICK_ACTIONS = [
  "look around",
  "wait",
  "inventory",
  "north",
  "south",
  "east",
  "west",
];

function isSystemTurn(t: AnyTurn): t is SystemTurn {
  return (t as SystemTurn).kind === "system";
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
  });
  const [pending, setPending] = useState(false);
  const [inputValue, setInputValue] = useState("");
  type ModalView = null | "select" | "objectives" | "win";
  const [modal, setModal] = useState<ModalView>(null);
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [hasStarted, setHasStarted] = useState(false);
  const [narrationOn, setNarrationOn] = useState<boolean>(() => {
    try { return localStorage.getItem("narrationOn") === "1"; } catch { return false; }
  });
  const [engineStatus, setEngineStatus] = useState<EngineStatus>({ kind: "idle" });
  const [audioByTurn, setAudioByTurn] = useState<Record<number, string>>({});
  const ttsRef = useRef<TTSEngine | null>(null);
  if (!ttsRef.current) ttsRef.current = new TTSEngine(setEngineStatus);

  const renderTurn = useCallback((turnId: number, text: string) => {
    const tts = ttsRef.current;
    if (!tts) return;
    tts.render(turnId, text)
      .then(({ url }) => setAudioByTurn((prev) => ({ ...prev, [turnId]: url })))
      .catch(() => { /* surfaced via engineStatus */ });
  }, []);

  const toggleNarration = useCallback(async () => {
    const next = !narrationOn;
    setNarrationOn(next);
    try { localStorage.setItem("narrationOn", next ? "1" : "0"); } catch {}
    if (next) {
      try { await ttsRef.current?.load(); } catch {}
    }
  }, [narrationOn]);

  const wsRef = useRef<WebSocket | null>(null);
  const nextIdRef = useRef(1);
  const inputRef = useRef<HTMLInputElement | null>(null);

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
        });
        setPresets(msg.presets);
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
      if (msg.type === "turn-start") {
        addTurn({
          id: nextIdRef.current++,
          input: msg.input,
          pending: true,
        });
        setPending(true);
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
          return {
            ...s,
            entries: msg.entries,
            threads: msg.threads,
            objectives: msg.objectives,
            turn: s.turn + 1,
          };
        });
        updateLastInputTurn((t) => ({ ...t, pending: false }));
        setPending(false);
        return;
      }
      if (msg.type === "win") {
        setModal("win");
        return;
      }
      if (msg.type === "error") {
        updateLastInputTurn((t) => ({
          ...t,
          pending: false,
          error: `${msg.source} error: ${msg.message}`,
        }));
        setPending(false);
        return;
      }
    });

    return () => {
      ws.close();
    };
  }, [addTurn, updateLastInputTurn]);

  // Auto-scroll to end of document on new turn or content update
  useEffect(() => {
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
    });
  }, [turns]);

  // Auto-render narration audio when narrationOn and a turn has narrative but no audio yet.
  // Using useEffect (not inline in the WS handler) avoids stale-closure bugs: narrationOn
  // is always current here because this effect re-runs whenever either turns or narrationOn changes.
  const [lastNarratedId, setLastNarratedId] = useState<number | null>(null);
  useEffect(() => {
    if (!narrationOn) return;
    // Walk from newest to find the most recent non-system turn with a narrative but no audio
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t && !isSystemTurn(t) && t.narrative && !(t.id in audioByTurn)) {
        renderTurn(t.id, t.narrative);
        setLastNarratedId(t.id);
        break;
      }
    }
  }, [turns, narrationOn, audioByTurn, renderTurn]);

  // Restore focus to the input when it becomes interactive again
  useEffect(() => {
    if (!pending && connected) inputRef.current?.focus();
  }, [pending, connected]);

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !wsRef.current || pending) return;

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
    wsRef.current.send(JSON.stringify({ type: "input", text: trimmed }));
  }, [addTurn, pending, stack]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
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
    wsRef.current?.send(JSON.stringify({ type: "start", presetSlug: slug }));
    setTurns([]);
    nextIdRef.current = 1;
    setAudioByTurn({});
    setLastNarratedId(null);
    ttsRef.current?.cache.clear();
    setHasStarted(true);
    setModal(null);
  }, []);

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
              <WorldRail entries={stack.entries} threads={stack.threads} />
            )}
          </aside>

          <main className="reading">
            <div className="turn-list">
              {turns.map((t) => (isSystemTurn(t) ? (
                <SystemBlock key={t.id} turn={t} />
              ) : (
                <TurnBlock
                  key={t.id}
                  turn={t}
                  audioUrl={audioByTurn[t.id]}
                  autoPlay={t.id === lastNarratedId}
                  onPlay={() => { if (t.narrative) { setLastNarratedId(t.id); renderTurn(t.id, t.narrative); } }}
                />
              )))}
            </div>
          </main>
        </div>
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
            {QUICK_ACTIONS.map((a) => (
              <button
                key={a}
                className="action-button"
                onClick={() => send(a)}
                disabled={pending || !connected}
              >
                {a}
              </button>
            ))}
            <button
              className={`action-button ${narrationOn ? "critical" : ""}`}
              onClick={toggleNarration}
              disabled={!connected}
              title={engineStatus.kind === "loading" ? `loading model… ${Math.round((engineStatus.progress ?? 0) * 100)}%` : ""}
            >
              {engineStatus.kind === "loading" ? `voice ${Math.round((engineStatus.progress ?? 0) * 100)}%` : `voice ${narrationOn ? "on" : "off"}`}
            </button>
            <button
              className="action-button"
              onClick={() => setModal("objectives")}
              disabled={!connected || stack.objectives.length === 0}
            >
              objectives
            </button>
            <button
              className="action-button critical"
              onClick={() => setModal("select")}
              disabled={!connected}
            >
              new game
            </button>
          </div>
        </div>
      </div>

      {modal !== null && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            {modal === "select" && (
              <SelectView
                presets={presets}
                onPick={startGame}
                onCancel={() => setModal(null)}
              />
            )}
            {modal === "objectives" && (() => {
              const p = stack.presetSlug
                ? presets.find((x) => x.slug === stack.presetSlug)
                : null;
              return (
                <ObjectivesView
                  title={p?.title ?? "Objectives"}
                  objectives={stack.objectives}
                  onClose={() => setModal(null)}
                />
              );
            })()}
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
          </div>
        </div>
      )}
    </>
  );
}

function TurnBlock({ turn, audioUrl, autoPlay, onPlay }: {
  turn: Turn;
  audioUrl?: string;
  autoPlay?: boolean;
  onPlay: () => void;
}) {
  const num = String(turn.id).padStart(2, "0");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Auto-play when the audio URL first becomes available and autoPlay is true,
  // or when autoPlay flips true for an already-cached URL (manual speaker click).
  useEffect(() => {
    if (autoPlay && audioUrl && audioRef.current) {
      audioRef.current.play().catch((err: unknown) => {
        if ((err as Error)?.name !== "NotAllowedError") console.warn("[narration] play failed", err);
      });
    }
  }, [autoPlay, audioUrl]);

  return (
    <div className="turn-block">
      <div className="turn-margin">
        <span aria-hidden="true">{num}</span>
        {turn.narrative && (
          <button
            type="button"
            className={`turn-speaker ${audioUrl ? "ready" : ""}`}
            onClick={() => { onPlay(); }}
            title={audioUrl ? "Play narration" : "Generate narration"}
            aria-label={audioUrl ? "Play narration" : "Generate narration"}
          >
            ◐
          </button>
        )}
      </div>
      <div className="turn-content">
        <p className="turn-input-echo">{turn.input}</p>
        {turn.narrative && <p className="turn-narrative">{turn.narrative}</p>}
        {turn.pending && !turn.narrative && !turn.error && (
          <p className="turn-pending">the world is responding…</p>
        )}
        {turn.error && <p className="turn-error">{turn.error}</p>}
        {audioUrl && <audio ref={audioRef} src={audioUrl} preload="auto" />}
      </div>
    </div>
  );
}

function SystemBlock({ turn }: { turn: SystemTurn }) {
  return (
    <div className={`turn-block system ${turn.variant || ""}`}>
      <div className="turn-content">
        <div className="turn-header">{turn.title}</div>
        {turn.variant === "briefing" ? (
          turn.items.map((item, idx) => (
            <p key={idx} className="turn-narrative">{item}</p>
          ))
        ) : (
          <ul className={`system-list ${turn.variant || ""}`}>
            {turn.items.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ul>
        )}
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

function ObjectivesView(props: {
  title: string;
  objectives: Objective[];
  onClose: () => void;
}) {
  return (
    <>
      <div className="modal-body">
        <div className="modal-title">{props.title}</div>
        <ObjectivesList objectives={props.objectives} />
      </div>
      <button className="action-button" onClick={props.onClose}>close</button>
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

function WorldRail(props: { entries: string[]; threads: string[] }) {
  return (
    <div className="rail-card">
      {props.entries.length > 0 && (
        <>
          <div className="rail-eyebrow">Established</div>
          <ul className="rail-entries">
            {props.entries.map((e, i) => (
              <li key={i} className="rail-entry">
                <span className="rail-entry-mark" aria-hidden>·</span>
                <span>{e}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {props.threads.length > 0 && (
        <>
          <div className="rail-eyebrow rail-eyebrow-secondary">Loose threads</div>
          <ul className="rail-threads">
            {props.threads.map((t, i) => (
              <li key={i} className="rail-thread">
                <span className="rail-thread-mark" aria-hidden>→</span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </>
      )}
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
