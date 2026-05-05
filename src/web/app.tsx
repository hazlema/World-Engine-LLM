import React, { useEffect, useRef, useState, useCallback } from "react";
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
              title: p.title.toUpperCase(),
              items: [p.body],
              variant: "briefing",
            }]);
          }
        }
        // Auto-open select view on a truly fresh world.
        if (msg.presetSlug === null && msg.turn === 0 && msg.entries.length === 0) {
          setModal("select");
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
                <TurnBlock key={t.id} turn={t} />
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
                onPick={(slug) => {
                  wsRef.current?.send(JSON.stringify({ type: "start", presetSlug: slug }));
                  setTurns([]);
                  nextIdRef.current = 1;
                  setModal(null);
                  // briefing is emitted by the incoming snapshot
                }}
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

function TurnBlock({ turn }: { turn: Turn }) {
  const num = String(turn.id).padStart(2, "0");
  return (
    <div className="turn-block">
      <div className="turn-margin" aria-hidden>{num}</div>
      <div className="turn-content">
        <p className="turn-input-echo">{turn.input}</p>
        {turn.narrative && <p className="turn-narrative">{turn.narrative}</p>}
        {turn.pending && !turn.narrative && !turn.error && (
          <p className="turn-pending">the world is responding…</p>
        )}
        {turn.error && <p className="turn-error">{turn.error}</p>}
      </div>
    </div>
  );
}

function SystemBlock({ turn }: { turn: SystemTurn }) {
  return (
    <div className={`turn-block system ${turn.variant || ""}`}>
      <div className="turn-margin" aria-hidden>
        {turn.variant === "briefing" ? "❦" : "§"}
      </div>
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
        <div className="modal-title">PICK A STORY</div>
        <div className="preset-row" onClick={surprise}>
          <span className="title">🎲 Surprise me</span>
          <span className="description">random preset</span>
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

function ObjectivesList({ objectives }: { objectives: Objective[] }) {
  return (
    <ul className="system-list">
      {objectives.map((o, i) => (
        <li key={i} className="objective-line">
          [{o.achieved ? "x" : " "}] {o.text}
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
        <div className="modal-title">{props.title.toUpperCase()}</div>
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
        <div className="modal-title">MISSION COMPLETE</div>
        <ObjectivesList objectives={props.objectives} />
      </div>
      <button className="action-button" onClick={props.onKeepExploring}>keep exploring</button>
      <button className="action-button" onClick={props.onNewGame}>new game</button>
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
            <span className="rail-objective-mark" aria-hidden>
              {o.achieved ? "◉" : "◯"}
            </span>
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
                <span className="rail-entry-mark" aria-hidden>◆</span>
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
                <span className="rail-thread-mark" aria-hidden>❦</span>
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
