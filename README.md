# World Engine

A text adventure where the world is generated turn by turn by an LLM.

You type what you do; a **narrator** model writes what happens next; an **archivist** model distills the result into stable facts that anchor future turns. The world remembers what it established and pushes back against impossible actions. Runs entirely against a local OpenAI-compatible endpoint — no API keys, no usage charges.

> **Status:** still being shaped. The engine grows sharper between sessions; expect occasional rough edges and behavior that changes as it learns.

**Demo:** [Gameplay video](https://www.youtube.com/watch?v=fcAVa8x6OsE) — streaming TTS narration and per-turn image generation in action.

## Quickstart

You'll need [Bun](https://bun.com) and an OpenAI-compatible local model server. The defaults assume [LM Studio](https://lmstudio.ai/) on port 1234.

1. **Install dependencies**
   ```bash
   bun install
   ```

2. **Start your local model server.** In LM Studio, load a capable instruction-tuned model and start the server on the default port (`http://localhost:1234`). The defaults in `src/api.ts` point both narrator and archivist at `google/gemma-3-12b` — a 12B-class model that handles the locality and objective rules well on modest hardware.

   Smaller 4B-class models often work too but tend to drift on nuanced rules. Larger models (Gemma 3 27B, Llama 3.1 70B, etc.) handle the rules with even more nuance if you have the VRAM. Other OpenAI-compatible servers (Ollama with the OpenAI shim, llama.cpp's `llama-server`, vLLM, etc.) work the same way. The endpoint and model names are constants at the top of `src/api.ts` — edit those lines to point at whatever you're running.

3. **Run the web app**
   ```bash
   bun --hot src/server.ts
   ```
   Open http://localhost:3000.

   First load shows the title screen. Pick a story and start typing what you do.

### Narration (optional)

The web app can read each turn aloud using Google's Gemini TTS. Audio streams chunk-by-chunk over a WebSocket so playback starts within ~1 second of the narrative appearing.

> **Note:** this replaces the previous local-Piper narration. I tried hard to keep narration free and local, but no local TTS I tested sounded good enough to listen to for hours of play. Gemini TTS needs a Google API key (Google AI Studio has a free tier that covers light play) — set `GEMINI_API_KEY` in `.env`. A proper in-app configuration screen for swapping providers, voices, and pasting in a key is planned; for now it's `.env` only.

Toggle narration in-app via the **voice off / voice on** button in the action bar. Audio is cached per turn; replays are instant. Disable any time — settings persist via `localStorage`.

### Images (optional)

Each turn has a `▦` button stacked under the speaker icon in the margin. Click it and the turn's narrative is sent to Google's `gemini-2.5-flash-image` (Nano Banana). The result drops in above the text as a cinematic 21:9 still — an establishing shot for the scene you just read. Cached per turn; the button greys out once an image exists.

> **Note:** like narration, this is **never automatic** — images only generate when you click `▦`. Uses the same `GEMINI_API_KEY` you already set for narration. Cost is per-image and falls under Google AI Studio's free tier for light play. The same future in-app configuration screen will cover image settings.

### Configuration

All settings live in `.env`. Bun loads it automatically — no `dotenv` needed.

```bash
# Required for narration and per-turn images.
GEMINI_API_KEY=your_key_here

# Optional: route the narrator through Gemini for richer prose.
# Defaults to the local OpenAI-compatible endpoint.
NARRATOR_PROVIDER=gemini                # gemini | local
NARRATOR_GEMINI_MODEL=gemini-2.5-flash  # optional; flash is the default

# Optional: route the interpreter through Gemini for robust intent parsing.
# Defaults to the local OpenAI-compatible endpoint.
INTERPRETER_PROVIDER=gemini                # gemini | local
INTERPRETER_GEMINI_MODEL=gemini-2.5-flash  # optional; flash is the default
```

> **Turning the Gemini narrator on upgrades both features at once.** Gemini writes noticeably tighter, more sensory prose than a 12B local model. And because the image generator's prompt _is_ the narrator's output, a sharper narrative also produces a sharper image downstream — better text feeds better pictures. Cost is one extra Gemini call per turn (~$0.0002 on Flash); the archivist still runs locally, and the interpreter can be routed independently via `INTERPRETER_PROVIDER` (see above).

## How it works

Each turn runs three model passes:

1. **Interpreter** parses the player's input into a structured action (movement, look, interact, freeform).
2. **Narrator** receives the established world state + active threads + the parsed action and writes 1–3 sentences of narrative.
3. **Archivist** reads the narrative and extracts new world facts and any objectives that just got achieved.

The world state lives in `world-stack.json` — an append-mostly list of established facts (`damaged transmitter half-buried in regolith`), an active-threads list, an objectives list, and a position. Every turn appends to a single `play-log.jsonl` for postmortem.

## Recent changes

- **Blocked-move feedback.** When your input looks like movement but doesn't name a cardinal direction (`go to the train`, `walk to the lander`, `follow the path`), the world now tells you instead of silently improvising. A toast appears with the cardinal directions to try, your input stays in the box for editing, and no turn is consumed. Pure non-movement actions (`examine`, `wait`, `talk`) are unaffected.
- **Optional Gemini narrator.** Set `NARRATOR_PROVIDER=gemini` to route the narrator pass through Gemini Flash instead of the local model. Prose comes out tighter and more specific; images downstream of that prose come out sharper for free, since the image generator's prompt is the narrator's output. Interpreter can also be routed via `INTERPRETER_PROVIDER` (see Configuration); archivist stays local. Defaults to local so nothing breaks for users without an API key.
- **Per-turn image generation.** Click `▦` next to a turn and the narrative becomes a 21:9 cinematic still via Google's `gemini-2.5-flash-image`. Optional and on-demand — same `GEMINI_API_KEY` already used for narration. The image lands as an establishing shot above the text.
- **Streaming Gemini TTS narration.** Replaced the local Piper integration. Audio now streams chunk-by-chunk over a WebSocket and starts playing about a second after the narrative appears. Trade-off: narration is no longer free or local — it needs a `GEMINI_API_KEY`. A proper in-app configuration screen for swapping providers/voices is planned.
- **Smarter objective handling.** The world now recognises when you've actually accomplished something even if the narrator phrases it differently. "The lid yields" counts as opening a chest; "you reach for the lock but it holds firm" doesn't.
- **Spatial objectives.** Goals can be tied to a specific tile on the map. To complete one, you actually have to be there — no more solving the whole story from your starting room.
- **Locality enforcement.** The world refuses to let you reach across the map. If the journal is in a deeper alcove and you're in the cellar, you'll need to walk over before you can read it. You can still see, hear, or call toward distant features.
- **Sector distribution.** The bundled stories Cellar of Glass and Lunar Rescue now scatter their goals across multiple tiles. Exploration matters again. The Last Train remains a single-room scene by design.

## Known Issues

- **Objective completion accuracy.** The archivist sometimes flips an objective on observational narrative — moving into a train car and seeing the conductor's empty seat shouldn't count as "find out where the conductor went," but currently can. The reverse also happens: a clear completion in the narrative occasionally goes unmarked. Type `/debug` in the chatbox to inspect what the archivist actually returned for the last turn.
- **Geography drift over long traversals.** After roughly five sequential moves in one direction the narrator can recycle details from earlier tiles instead of the current one. World state is correct; the prose just borrows from neighbors.
- **Vanishing established facts.** An entity vividly canonized in one turn (e.g. "a solar array half-buried at the top of the slope") may disappear from the established list by the next turn. Things noticed-but-not-touched are most at risk.
- **Wrong-noun world-update toasts.** Occasionally the toast surfaces an entry about a different object than the one your action targeted — entry/thread extraction latches onto the most recently mentioned noun rather than the action's subject.
- **Self-contradiction across adjacent turns.** Turn N may reveal "a corner of a schematic beneath the note"; turn N+1 says the note "peels away to reveal nothing." Likely a context-window or archivist-timing issue; under investigation.
- **Audio queue / overlap / multi-tab echo.** Re-enabling narration mid-session can flush a stale queue; a new turn's audio can overlap the previous clip; two tabs on the same server echo each other because audio messages are broadcast.
- **Cardinal-only movement.** "Walk to the lander," "head west-by-northwest," or any non-cardinal phrasing stays on the current tile and surfaces a toast. Use `north / south / east / west`.
- **No first-class inventory.** Items you "take" stay in the world's established entries — there's no separate inventory data structure or UI yet. Type `inventory` to ask the world what you're carrying.

> Balance is key, we're working on it. 😅

## Future

- **In-app configuration screen.** Providers, API keys, voices, and image styles currently live across `.env` and a few UI buttons. A consolidated settings panel — with a "free Gemma-only" preset and a "premium Gemini" preset — is planned.
- **Self-building exploration map.** An 80%-width modal that draws tiles as you visit them with notes attached. The world-update toast could deep-link into it.
- **Local Stable Diffusion image generation.** A free-tier alternative to Gemini Nano Banana via SDXL Turbo / Lightning / FLUX Schnell, so per-turn images don't require an API key.
- **Single playback controller.** One owner of the in-flight render and current clip with abort-on-change semantics; collapses the three audio bugs above into a single fix.
- **Compound command detection.** Pre-interpreter pass that flags multi-action input ("go north and grab the key") and surfaces a one-action-per-turn message instead of letting the model silently pick one.
- **VPS hosting + multi-user.** State is currently single-user JSON. Per-user save state and a handle/email identity are the next step before sharing publicly.

## Stories (presets)

Presets in `presets/*.md` define a starting situation: a few seed facts, optional objectives, and a briefing the player reads on turn zero. Format:

```markdown
---
title: Cellar of Glass
description: A locksmith's tomb beneath the cathedral.
objects:
  - brass key tarnished green at the bow
  - iron-bound chest with a broken lock plate
objectives:
  - Find the locksmith's journal @ -1,0
  - Open the iron-bound chest @ 0,0
  - Escape the cellar before the candles burn out @ 0,1
---
You are a thief who descended into the cellar of an abandoned cathedral...
```

Append `@ x,y` to an objective to anchor it to a tile — players have to actually be there to complete it. Objectives without a coordinate stay achievable anywhere.

> **Coordinate convention.** The first number is north-south (north positive, south negative); the second is east-west (east positive, west negative). So `@ -1,0` is one tile south of start, and `@ 0,1` is one tile east. Same convention applies anywhere positions appear (the `/debug` modal, `world-stack.json`, etc.).

Drop a new `.md` in `presets/` and it'll appear on the title screen on the next page load.

## Architecture

- **Runtime:** Bun (server, bundler, test runner)
- **Server:** `Bun.serve` with WebSocket — `src/server.ts`
- **Web:** React 19, single-file app in `src/web/app.tsx`, served via Bun's HTML import
- **State:** plain JSON file (`world-stack.json`) — fine for single-user; multi-user would need per-user namespacing

## API Costs

While I cant give you an exact cost, with all my testing, hundreds of images and narrations for 8 hours cost me $1.97

## Tests

```bash
bun test
```

Covers the stack, presets, engine prompts, server message handlers, and the api client.

## License

MIT — see [LICENSE](./LICENSE).
