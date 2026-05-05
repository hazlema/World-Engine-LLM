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
  variant?: "threads";
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
  type ModalView = null | "select" | "briefing" | "win";
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

  return (
    <>
      <div className="app">
        <div className="app-header">W O R L D &nbsp;&nbsp; E N G I N E</div>
        <div className={`connection-status ${connected ? "connected" : ""}`}>
          {connected ? "■ CONNECTED" : "□ CONNECTING…"}
        </div>
        <div className="turn-list">
          {turns.map((t) => (isSystemTurn(t) ? (
            <SystemBlock key={t.id} turn={t} />
          ) : (
            <TurnBlock key={t.id} turn={t} />
          )))}
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
              onClick={() => setModal("briefing")}
              disabled={!connected || stack.presetSlug === null}
            >
              mission
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
                  setModal(slug === null ? null : "briefing");
                }}
                onCancel={() => setModal(null)}
              />
            )}
            {modal === "briefing" && (() => {
              const p = presets.find((x) => x.slug === stack.presetSlug);
              return p ? (
                <BriefingView
                  title={p.title}
                  body={p.body}
                  objectives={stack.objectives}
                  onClose={() => setModal(null)}
                />
              ) : (
                <div className="modal-body">No mission active.</div>
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
  return (
    <div className="turn-block">
      <div className="turn-image placeholder" />
      <div className="turn-content">
        <div className="turn-header">Turn #{turn.id}</div>
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
    <div className="turn-block system">
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

function BriefingView(props: {
  title: string;
  body: string;
  objectives: Objective[];
  onClose: () => void;
}) {
  return (
    <>
      <div className="modal-body">
        <div className="modal-title">{props.title.toUpperCase()}</div>
        <p>{props.body}</p>
        <div className="modal-divider" />
        <div>OBJECTIVES</div>
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
