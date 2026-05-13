![World Engine — A world that pushes back](media/title.png)

# World Engine

There's a chest. It's locked.

 The objective says open the chest. But, the game does not tell you how or even know how. 
 
 There's no designated key waiting in a designated drawer. The lock might be jammed, in which case the key you find won't help. So you wander.

A few rooms later you find an axe. The axe wasn't placed there to solve the chest — nothing is placed to solve anything. Nothing was placed at all until you walked in the room. 

But you're holding an axe and there's a locked chest, and when you swing it at the lid, the world agrees that's what happens.

Rooms, objects, and complications get generated turn by turn as you explore them. Some of what shows up will turn out to matter. You won't know which until you try something.

Replay the same preset and the axe might not exist. Maybe there's a crowbar. Maybe the chest is rusted shut and now you're looking for water. 

Maybe the chest contains something you really wish it hadn't. The seed scenario is the same; what fills it in isn't.

You can also skip the presets entirely and start in an empty open world — type what you do, and the world assembles itself around you.

> **Status:** still being shaped. The engine grows sharper between sessions; expect occasional rough edges and behavior that changes as it learns.

**Demo:** [Gameplay video](https://www.youtube.com/watch?v=_BUib3K9mK4) — streaming TTS narration and per-turn image generation in action.

## Quickstart

You'll need [Bun](https://bun.com) and an OpenAI-compatible local model server. The defaults assume [LM Studio](https://lmstudio.ai/) on port 1234.

1. **Install dependencies**
   ```bash
   bun install
   ```

2. **Start your local model server.** In LM Studio, download and load the [lmstudio-community/NVIDIA-Nemotron-3-Nano-30B-A3B-GGUF](https://huggingface.co/lmstudio-community/NVIDIA-Nemotron-3-Nano-30B-A3B-GGUF) (see [Recommended local models](#recommended-local-models)) and start the server on the default port (`http://localhost:1234`). **Turn thinking OFF** in LM Studio's Developer tab on the model's Reasoning setting — otherwise narrator turns take ~30s. With it off they run ~2.3s.

   Smaller 4B-class models often work too but tend to drift on nuanced rules. Larger models (Gemma 3 27B, Llama 3.1 70B, etc.) handle the rules with even more nuance if you have the VRAM. Other OpenAI-compatible servers (Ollama with the OpenAI shim, llama.cpp's `llama-server`, vLLM, etc.) work the same way. The endpoint and model names are constants at the top of `src/api.ts` — edit those lines to point at whatever you're running.

3. **Run the web app**
   ```bash
   bun --hot src/server.ts
   ```
   Open http://localhost:3000.

   First load shows the title screen. Pick a story and start typing what you do.

### Narration (optional, not free)

The web app can read each turn aloud using Google's Gemini TTS. Audio streams chunk-by-chunk over a WebSocket so playback starts within ~1 second of the narrative appearing.

Toggle narration in-app via the **voice off / voice on** button in the action bar. Audio is cached per turn; replays are instant. Disable any time — settings persist via `localStorage`.

### Images (optional, not free)

Each turn has a `▦` button stacked under the speaker icon in the margin. Click it and the turn's narrative is sent to Google's `gemini-2.5-flash-image` (Nano Banana). The result drops in above the text as an establishing shot for the scene you just read. The model generates 1:1; the timeline crops it to a cinematic strip — **click any image to open the full square in a fullscreen lightbox** (ESC or click outside to close). Cached per turn; the button greys out once an image exists.

### Gallery

When a turn produces an image you want to keep, click the ★ button next to the `▦` — it saves the image to the server's `media/` directory. To browse everything you've saved, type `/gallery` in the chat window. A wide modal opens with the selected image on top, prev/next arrows on either side, and a horizontally-scrolling thumbnail strip below. Click any thumbnail to jump to it, click the big image to lightbox it, ← / → keys to navigate, ESC to close.

## Configuration

All settings live in `.env`. Copy `.env-sample` to get started.

```bash
## Required for any stage with provider=local
LM_STUDIO_URL=http://localhost:1234

## Required for any stage with provider=openrouter
OPENROUTER_API_KEY=

## One line per pipeline stage: provider,model
## provider must be one of: local, openrouter
NARRATOR_PROVIDER=openrouter,nvidia/nemotron-3-nano
ARCHIVIST_PROVIDER=local,nvidia/nemotron-3-nano
INTERPRETER_PROVIDER=local,nvidia/nemotron-3-nano

## Optional Gemini features (each requires GEMINI_API_KEY)
GEMINI_API_KEY=
USE_GEMINI_IMAGES=false
USE_GEMINI_NARRATION=false
```

The server validates this at startup. If anything is missing or malformed, it prints every problem to stderr and exits before opening the port.

**Lowest-effort path:** an OpenRouter key with all three stages set to `openrouter,nvidia/nemotron-3-nano`. No local model required, no Gemini key required. The free Nemotron tier is rate-limited but workable for solo play.

**Fully local path:** LM Studio running on `localhost:1234` with the Nemotron-3-Nano model loaded, all three stages set to `local,nvidia/nemotron-3-nano`, no OpenRouter key needed.

**Hidden tuning overrides** for debugging: `LOCAL_NARRATOR_TEMP`, `LOCAL_ARCHIVIST_TEMP`, `LOCAL_INTERPRETER_TEMP` and the matching `_TOP_P` variants. If set, they're sent to LM Studio with each call. If unset (the default), the call omits these parameters and the model's own defaults apply.

### Recommended local models

After working through a 12-model narrator bake-off and a follow-up training experiment, exactly one local model delivers all three of:

- **Prose quality** — named NPCs, sensory anchoring, scene escalation, in-character narrator voice.
- **Game-mode strictness** — refuses player-declared unestablished abilities *in fiction*. Player says *"use my magic cloak and transport to the moon"*; world says *"the cloak shudders, but the stone remains beneath you — the moon hangs distant and cold, unreachable by cloth and will."* No fine-tuning required.
- **Acceptable latency on consumer hardware** — full turn under ~7 seconds on a 16 GB GPU.

**Download:** [lmstudio-community/NVIDIA-Nemotron-3-Nano-30B-A3B-GGUF](https://huggingface.co/lmstudio-community/NVIDIA-Nemotron-3-Nano-30B-A3B-GGUF) — pick the **IQ3_K_L** quant file. The model is Nvidia's Nemotron-3-Nano 30B-A3B (mixture-of-experts: 30B total params, ~3B active per token). At Q3_K_L it's ~10 GB VRAM and the prose quality survives the quantization cleanly. Higher quants (Q4_K_M, etc.) work too if you have the headroom but offer no meaningful quality bump over Q3_K_L on this prompt. LM Studio serves it under the id `nvidia/nemotron-3-nano`.

**Config:** all three stages route to the same model — no per-stage split needed.

> **CRITICAL: turn thinking OFF at the LM Studio server.** In LM Studio: Developer tab → model card for `nvidia/nemotron-3-nano` → Reasoning setting → off. With thinking on, narrator turns take ~30s and may burn the full token budget on scratchpad; thinking off drops them to ~2.3s. The in-prompt `detailed thinking off` directive Nvidia documents *does not* take effect through LM Studio's GGUF runtime — the server toggle is the actual lever. Unless you have a spare H100 sitting around, this step is required.

## How it works

Each turn runs three model passes:

1. **Interpreter** parses the player's input into a structured action (movement, look, interact, freeform).
2. **Narrator** receives the established world state + active threads + the parsed action and writes 1–3 sentences of narrative.
3. **Archivist** reads the narrative and extracts new world facts and any objectives that just got achieved.

The world state lives in `world-stack.json` — an append-mostly list of established facts (`damaged transmitter half-buried in regolith`), an active-threads list, an objectives list, and a position. Every turn appends to a single `play-log.jsonl` for postmortem.

## Tips

- **Presets are fun; Empty World is where the real magic happens.** The bundled stories (Cellar of Glass, Lunar Rescue, The Last Train) give you a setting and a goal — great for a focused session or first-time play. But for the *best* experience, start with no preset and just type your opening line. You genuinely don't know what you're going to get, and that's the point — your mind shapes the adventure. The world grows around whatever premise you bring.
- **The world builds as you look.** Rooms, objects, and details only exist after the narrator establishes them — and once established, the engine has to honor them in later turns. A tile you walked straight through is thin; a tile you actually examined has weight. Spending turns on `look`, `examine`, and `search` isn't downtime — it's what makes the world feel real to come back to.
- **Seed the scene on turn one in freeplay.** Empty World mode has no preset, so the narrator improvises a setting from your first input. `look around` gives it nothing to anchor to and you'll get a generic room. A scene-setting line does the work for you:
  > Don't open the airlock! We're on a deep-space station with over 300,000 people aboard — open it and you'll suck them all into space.

  One sentence, and the narrator has a location, stakes, and a constraint to honor. From there the world fills itself in around you.

## Recent changes

- **Image gallery + lightbox.** New `/gallery` slash command opens a wide modal listing every image in the server's `media/` directory — big preview on top, prev/next arrows, scrolling thumbnail strip below, ← / → keys + ESC. Each turn's generated image gets a new ★ button to save it to the gallery in one click (no more right-click-save-as). And anywhere an image appears — turn card or gallery — clicking it opens a fullscreen lightbox at the image's true resolution. Useful since the timeline view crops images to a cinematic strip by CSS, but the underlying frame is square; the lightbox shows what the model actually rendered.
- **Fully local play, properly.** New `LM_STUDIO_URL` env var lets you point at a non-default LM Studio (custom port, host, basic auth). New `LOCAL_MODEL` plus per-stage `LOCAL_NARRATOR_MODEL` / `LOCAL_ARCHIVIST_MODEL` / `LOCAL_INTERPRETER_MODEL` let you route each pipeline stage independently — typically a fast 3B model on the narrator with a 12B model on the archivist so LOCATE objectives still fire. The narrator prompt also got a new "ending examples" block that brings smaller models into rule compliance (no more trailing "What do you examine first?" closers). The bake-off behind all of this lives at [`docs/local-narrator-bake-off.md`](docs/local-narrator-bake-off.md).
- **Better startup and runtime diagnostics.** Boot validates `NARRATOR_PROVIDER` / `INTERPRETER_PROVIDER` are valid values and exits with a clear message if a Gemini provider is set without `GEMINI_API_KEY`. The web UI also stops auto-firing TTS / image requests when the server reports the key is missing — one toast on first failure, then silence, instead of repeated console errors. The `/debug` pane shows each pipeline stage's actual model (`narrator: local / mistralai/ministral-3-3b`, `archivist: local / google/gemma-3-12b`, etc.) so routing is visible at runtime.
- **`/debug` command.** Type `/debug` in the chatbox to open a modal showing live world state and the last turn's full pipeline — interpreter classification, raw archivist output (entries, threads, `achievedObjectiveIndices`, `moved`, `locationDescription`), provider info. The diagnostic surface that made most of the recent narrative-quality work traceable.
- **Spatial and content discipline.** Cardinal moves are tile transitions, not in-scene steps — `north` from the lander cabin takes you outside on the regolith, not to a back wall. Items established in the world (especially preset-seeded ones) are surfaced by name in the prose, not via vague descriptors the player can't reference back. When an active "Find / Locate / Reach" objective names an item that's at your tile, the narrative produces the named target — no substitution with alternative objects, no preemptive denial of presence. Action-verb objectives ("Send", "Restore", "Repair") still require depicted action, not just arrival.
- **Archivist hardening.** Three classes of objective-completion misfires fixed: atmospheric clues no longer mark "find out X" objectives complete; static state-description ("the chest gapes open") no longer marks "open X" objectives complete; cumulative-stack inference is blocked. Completion now requires the narrative to depict the moment of change or discovery this turn. Stack supersession also tightened: when you take, place, break, or change an item — or a count drops (3 candles → 2) — the entries list updates instead of accumulating outdated facts. Established entries that aren't mentioned in a given turn's narrative are preserved unchanged — absence is not invalidation.
- **Anti-retcon rule.** The narrator can't invent offscreen backstory or false memories ("you remember leaving the key upstairs in the alchemist's study") to delete an established item. Items leave the world only through depicted on-screen action this turn — the player taking, breaking, or using them, or an NPC depicted on-screen doing the same.
- **Blocked-move feedback.** When your input looks like movement but doesn't name a cardinal direction (`go to the train`, `walk to the lander`, `follow the path`), the world now tells you instead of silently improvising. A toast appears with the cardinal directions to try, your input stays in the box for editing, and no turn is consumed. Pure non-movement actions (`examine`, `wait`, `talk`) are unaffected.

## Known Issues

- **Mild narrative drift on long runs.** The structural drift classes (item retcon, count drift, oscillating entries) are closed. What can still happen on long sessions: the narrator occasionally recycles phrasings or skips an item the player hasn't touched in a while. Less severe than before, but worth flagging.
- **Wrong-noun world-update toasts.** Occasionally the toast surfaces an entry about a different object than the one your action targeted — extraction latches onto the most recently mentioned noun rather than the action's subject. (Observed primarily on the previous local narrator/archivist combo; the current `nvidia/nemotron-3-nano` config may improve this, not yet verified across a long run.)
- **LOCATE objectives complete on tile entry.** When you walk onto a tile that contains a "find / locate / reach the X" target, the deterministic safety net in `stack.ts` marks the objective complete the moment you arrive — before you've looked at or examined the thing. Should require an explicit `look`, `inspect`, or `examine` to fire.
- **Duplicate objective-completion events.** Sometimes the same objective gets credited twice in a single session — likely the deterministic safety net and the archivist attributing the same change independently, with the `unionAchievedIndices` dedup missing the overlap.
- **Audio queue / overlap / multi-tab echo.** Re-enabling narration mid-session can flush a stale queue; a new turn's audio can overlap the previous clip; two tabs on the same server echo each other because audio messages are broadcast.
- **Cardinal-only movement.** "Walk to the lander," "head west-by-northwest," and stair phrasings like `up`/`down` stay on the current tile and surface a toast. Use `north / south / east / west`.
- **No first-class inventory.** Items you "take" stay in the world's established entries — there's no separate inventory data structure or UI. Type `inventory` and the narrator synthesizes a list from the entries it knows about, but specific picked-up items occasionally don't make the synthesis.

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
