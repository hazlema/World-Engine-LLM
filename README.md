# World Engine

A text adventure where the world is generated turn by turn by an LLM.

You type what you do; a **narrator** model writes what happens next; an **archivist** model distills the result into stable facts that anchor future turns. The world remembers what it established and pushes back against impossible actions. Runs entirely against a local OpenAI-compatible endpoint — no API keys, no usage charges.

## Quickstart

You'll need [Bun](https://bun.com) and an OpenAI-compatible local model server. The defaults assume [LM Studio](https://lmstudio.ai/) on port 1234.

1. **Install dependencies**
   ```bash
   bun install
   ```

2. **Start your local model server.** In LM Studio, load these two models and start the server on the default port (`http://localhost:1234`):
   - Narrator: `google/gemma-4-e2b`
   - Archivist: `nvidia/nemotron-3-nano-4b`

   Other OpenAI-compatible servers (Ollama with the OpenAI shim, llama.cpp's `llama-server`, vLLM, etc.) work the same way. The endpoint and model names are constants at the top of `src/api.ts` — edit those two lines to point at whatever you're running.

3. **Run the web app**
   ```bash
   bun --hot src/server.ts
   ```
   Open http://localhost:3000.

   First load shows the title screen. Pick a story and start typing what you do.

### Narration (optional)

The web app can read each turn aloud using [Piper](https://github.com/rhasspy/piper) — a small, fast, Linux-friendly TTS. On first start, the server downloads the piper binary (~25 MB) and the `en_US-lessac-medium` voice (~38 MB) into `bin/`. Subsequent starts skip the download. The download is one-time and Linux x86_64 only; on other platforms install piper manually and place the binary at `bin/piper/piper`.

Toggle narration in-app via the **voice off / voice on** button in the action bar. Audio renders are cached per turn; replays are instant. Disable any time — settings persist via `localStorage`.

## How it works

Each turn runs three model passes:

1. **Interpreter** parses the player's input into a structured action (movement, look, interact, freeform).
2. **Narrator** receives the established world state + active threads + the parsed action and writes 1–3 sentences of narrative.
3. **Archivist** reads the narrative and extracts new world facts and any objectives that just got achieved.

The world state lives in `world-stack.json` — an append-mostly list of established facts (`damaged transmitter half-buried in regolith`), an active-threads list, an objectives list, and a position. Every turn appends to a single `play-log.jsonl` for postmortem.

## Stories (presets)

Presets in `presets/*.md` define a starting situation: a few seed facts, optional objectives, and a briefing the player reads on turn zero. Format:

```markdown
---
title: The Last Train
description: One car, six strangers, ninety minutes.
objects:
  - leather satchel left on a window seat
  - half-empty bottle of plum wine on the floor
objectives:
  - Find out where the conductor went
  - Identify the owner of the leather satchel
---
You are a passenger on the last train out of a city you no longer trust...
```

Drop a new `.md` in `presets/` and it'll appear on the title screen on the next page load.

## Architecture

- **Runtime:** Bun (server, bundler, test runner)
- **Server:** `Bun.serve` with WebSocket — `src/server.ts`
- **Web:** React 19, single-file app in `src/web/app.tsx`, served via Bun's HTML import
- **State:** plain JSON file (`world-stack.json`) — fine for single-user; multi-user would need per-user namespacing

## Tests

```bash
bun test
```

Covers the stack, presets, engine prompts, server message handlers, and the api client.

## License

MIT — see [LICENSE](./LICENSE).
