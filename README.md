![World Engine — A world that pushes back](promo/title2.png)

# World Engine

> A text adventure where the world is generated turn-by-turn as you explore. Nothing is placed; everything is improvised.

---

There's a chest. It's locked.

The objective says: open the chest. But the game doesn't tell you how, because it doesn't know yet.

There's no designated key waiting in a designated drawer. The lock might be jammed, in which case the key you find won't help. So you wander.

A few rooms later, you find an axe. The axe wasn't placed there to solve the chest. Nothing is placed to solve anything. Nothing was placed at all until you walked into the room.

But you're holding an axe, and there's a locked chest. When you swing at the lid, the world agrees that's what happens.

Rooms, objects, and complications are generated turn by turn as you explore. Some of what appears will turn out to matter. You won't know which things matter until you try something.

Replay the same preset and the axe might not exist. Maybe there's a crowbar. Maybe the chest is rusted shut and now you're looking for water.

Maybe the chest contains something you really wish it hadn't.

The seed scenario is the same; what fills it in isn't.

You can also skip the presets entirely and start in an empty open world. Type what you do, and the world assembles itself around you.

> **Status:** still being shaped. The engine grows sharper between sessions; expect occasional rough edges and behavior that changes as it learns.

**Demo:** [Gameplay video #1](https://www.youtube.com/watch?v=Lk7heHbcHik) — Full game of Merlins Daughter (20m)

**Demo:** [Gameplay video #2](https://www.youtube.com/watch?v=_BUib3K9mK4) — streaming TTS narration and per-turn image generation in action. Slightly old, New ui and logic now but still aa good example

---

## Contents

- [Quick Start](#quick-start)
- [How to Play](#how-to-play)
- [Optional: Narration](#optional-narration)
- [Optional: Per-Turn Images](#optional-per-turn-images)
- [Configuration](#configuration)
- [Technical](#technical)
  - [How it works](#how-it-works)
  - [Recommended local model](#recommended-local-model)
  - [Stories / presets](#stories--presets)
  - [Architecture](#architecture)
  - [Tests](#tests)
- [Roadmap](#roadmap)
- [Known Issues](#known-issues)
- [Recent Changes](#recent-changes)
- [License](#license)

---

## Quick Start

You'll need [Bun](https://bun.com) and an OpenAI-compatible local model server. The defaults assume [LM Studio](https://lmstudio.ai/) on port `1234`.

**1. Install dependencies**

```bash
bun install
```

**2. Start your local model server**

In LM Studio, download and load [`lmstudio-community/NVIDIA-Nemotron-3-Nano-30B-A3B-GGUF`](https://huggingface.co/lmstudio-community/NVIDIA-Nemotron-3-Nano-30B-A3B-GGUF), then start the server on the default port (`http://localhost:1234`).

> ⚠️ **Turn thinking OFF**, or your game will be very slow. See [Recommended local model](#recommended-local-model) for details.

**3. Run the web app**

```bash
bun --hot src/server.ts
```

Open [`http://localhost:3000`](http://localhost:3000), pick a story, and start typing what you do.

> Prefer cloud over local? See the [lowest-effort path](#configuration) — an OpenRouter key and you're done.

---

## How to Play

### Preset scenarios are fun; Empty World is where the real magic happens

The bundled stories — *Cellar of Glass*, *Lunar Rescue*, and *The Last Train* — give you a setting and a goal. Great for a focused session or first-time play.

But for the *best* experience, start with no preset and type your opening line. You genuinely don't know what you're going to get, and that's the point. Your mind shapes the adventure. The world grows around whatever premise you bring.

### The world builds as you look

Rooms, objects, and details only exist after the narrator establishes them. Once established, the engine has to honor them in later turns.

A tile you walked straight through is thin. A tile you actually examined has weight.

Spending turns on `look`, `examine`, and `search` isn't downtime. It's what makes the world feel real when you come back to it.

### Seed the scene on turn one in freeplay

Empty World mode has no preset, so the narrator improvises a setting from your first input. `look around` gives it nothing to anchor to, so you'll get a generic room.

A scene-setting line does the work for you:

> Don't open the airlock! We're on a deep-space station with over 300,000 people aboard. Open it and you'll suck them all into space.

One sentence gives the narrator a location, stakes, and a constraint to honor. From there, the world fills itself in around you.

---

## Optional: Narration

World Engine can read each turn aloud. Pick a path.

### Path A — Local TTS (free, requires Python + GPU)

Uses [ResembleAI Chatterbox Turbo](https://github.com/resemble-ai/chatterbox) via a small Python sidecar that Bun spawns automatically on startup.

```bash
# One-time install (Python 3.11+)
python -m venv tts_sidecar/.venv
source tts_sidecar/.venv/bin/activate
pip install -r tts_sidecar/requirements.txt

# One-time: generate the bundled voice references
python tts_sidecar/generate_voices.py
```

Roughly 5 GB disk and 5–10 minutes for the install. Chatterbox uses ~1.5 GB VRAM (fits comfortably alongside Nemotron's ~10 GB on a 16 GB GPU). CPU mode works but is ~10× slower. See [`tts_sidecar/README.md`](tts_sidecar/README.md) for details.

In `.env`:

```bash
USE_NARRATION=true
USE_ELEVENLABS=false
```

### Path B — ElevenLabs (cloud, paid, no local install)

Hand off TTS to [ElevenLabs](https://elevenlabs.io). No Python, no GPU, but you'll need a paid plan. A free account gets you ~10k credits — enough for a few full games. Six bucks gets you a lot more.

In `.env`:

```bash
USE_NARRATION=true
USE_ELEVENLABS=true
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_VOICES=voice1:kqVT88a5QfII1HNAEPTJ,voice2:z7i51AlFqQJ8JzM16o7e
ELEVENLABS_MODEL=eleven_flash_v2_5
```

`ELEVENLABS_VOICES` format is `label:voice_id,label:voice_id,...`. Labels show up in the narration dropdown — rename them to whatever you want. Browse voice IDs at the [ElevenLabs voice library](https://elevenlabs.io/app/voice-library). `eleven_flash_v2_5` is the half-price tier with great quality; `eleven_multilingual_v2` is the higher-cost flagship.

### Path C — Skip narration entirely

In `.env`:

```bash
USE_NARRATION=false
```

The game runs fine silently. Skip the Python install too.

### In-game controls

Toggle narration with the **voice off / voice on** button in the action bar. Audio is cached per turn, so replays are instant. A voice selector is also available in the action bar.

---

## Optional: Per-Turn Images

World Engine can generate an image for each turn with Nano Banana.

Toggle images with the **images off / images on** button in the action bar. Images are cached per turn, so replays are instant. You can also change the art style.

### Gallery

When a turn produces an image you want to keep, click the ★ button next to the `▦`. This saves the image to the server's `media/` directory.

To browse everything you've saved, type `/gallery` in the chat window. A wide modal opens with the selected image on top, prev/next arrows on either side, and a horizontally scrolling thumbnail strip below.

Click any thumbnail to jump to it. Click the big image to lightbox it. Use ← / → to navigate and ESC to close.

---

## Configuration

All settings live in `.env`. Copy `.env-sample` to get started.

```bash
LM_STUDIO_URL=http://localhost:1234
OPENROUTER_API_KEY=

NARRATOR_PROVIDER=openrouter,nvidia/nemotron-3-nano-30b-a3b:free
ARCHIVIST_PROVIDER=openrouter,nvidia/nemotron-3-nano-30b-a3b:free
INTERPRETER_PROVIDER=openrouter,nvidia/nemotron-3-nano-30b-a3b:free

###########################################################
## Optional Gemini features
##
## Required if either USE_GEMINI_* flag below is true.
## Get a key at https://aistudio.google.com/app/api-keys
###########################################################
GEMINI_API_KEY=
USE_GEMINI_IMAGES=true

###########################################################
## ElevenLabs (cloud TTS) — overrides local Chatterbox.
###########################################################
USE_ELEVENLABS=false
ELEVENLABS_API_KEY=
ELEVENLABS_VOICES=Declan:kqVT88a5QfII1HNAEPTJ,Josh:pg7Nd5b8Y3tnfSndq5lh,Samantha:tVplNHhGm5NvP54mKUGh,Emma:56bWURjYFHyYyVf490Dp
ELEVENLABS_MODEL=eleven_flash_v2_5

USE_NARRATION=false

```

The server validates this at startup. If anything is missing or malformed, it prints every problem to stderr and exits before opening the port. It also sends a 1-token reachability probe to every unique `(provider, model)` pair in parallel — bad API keys, missing OpenRouter credits, an unreachable LM Studio, and unloaded models all surface as per-stage error lines and exit before the port opens. Once probes pass, a 60-second keep-alive ping holds each connection warm so the first turn doesn't eat TLS or model-load cold-start latency.

### Recommended paths

**Lowest effort:** an OpenRouter key with all three stages set to `openrouter,nvidia/nemotron-3-nano`. No local model required, no Gemini key required. The free Nemotron tier is rate-limited but workable for solo play.

**Fully local:** LM Studio running on `localhost:1234` with the Nemotron-3-Nano model loaded, all three stages set to `local,nvidia/nemotron-3-nano`, no OpenRouter key needed.

**Narration is a separate setup.** See [Optional: Narration](#optional-narration) for the three paths.

### Hidden tuning overrides

For debugging: `LOCAL_NARRATOR_TEMP`, `LOCAL_ARCHIVIST_TEMP`, `LOCAL_INTERPRETER_TEMP`, and the matching `_TOP_P` variants. If set, they're sent to LM Studio with each call. If unset (the default), the call omits these parameters and the model's own defaults apply.

---

## Technical

### How it works

Each turn runs three model passes:

1. **Interpreter** parses the player's input into a structured action: movement, look, interact, or freeform.
2. **Narrator** receives the established world state, active threads, and parsed action, then writes 1–3 sentences of narrative.
3. **Archivist** reads the narrative and extracts new world facts and any objectives that just got achieved.

The world state lives in `world-stack.json`: an append-mostly list of established facts (e.g. `damaged transmitter half-buried in regolith`), an active-threads list, an objectives list, and a position. Every turn also appends to a single `play-log.jsonl` for postmortem.

### Recommended local model

After a 12-model narrator bake-off and a follow-up training experiment, exactly one local model delivered all three things World Engine needed:

- **Prose quality:** named NPCs, sensory anchoring, scene escalation, and an in-character narrator voice.
- **Game-mode strictness:** refuses player-declared, unestablished abilities *in fiction*. Player says *"use my magic cloak and transport to the moon"*; world says *"the cloak shudders, but the stone remains beneath you. The moon hangs distant and cold, unreachable by cloth and will."* No fine-tuning required.
- **Acceptable latency on consumer hardware:** full turn under ~7 seconds on a 16 GB GPU.

**Download:** [`lmstudio-community/NVIDIA-Nemotron-3-Nano-30B-A3B-GGUF`](https://huggingface.co/lmstudio-community/NVIDIA-Nemotron-3-Nano-30B-A3B-GGUF) — pick the **IQ3_K_L** quant file.

The model is Nvidia's Nemotron-3-Nano 30B-A3B, a mixture-of-experts model with 30B total parameters and about 3B active per token. At Q3_K_L, it uses about 10 GB of VRAM, and the prose quality survives the quantization cleanly. Higher quants (Q4_K_M) work too if you have the headroom, but they don't offer a meaningful quality bump over Q3_K_L on this prompt.

LM Studio serves it under the id `nvidia/nemotron-3-nano`. All three stages route to the same model — no per-stage split needed.

> 🚨 **CRITICAL: turn thinking OFF at the LM Studio server.**
>
> In LM Studio: **Developer tab → model card for `nvidia/nemotron-3-nano` → Reasoning setting → off**.
>
> With thinking on, narrator turns take ~30s and may burn the full token budget on scratchpad. Thinking off drops them to ~2.3s. The in-prompt `detailed thinking off` directive Nvidia documents *does not* take effect through LM Studio's GGUF runtime. The server toggle is the actual lever. Unless you have a spare H100 sitting around, this step is required.

### Stories / presets

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

Append `@ x,y` to an objective to anchor it to a tile. Players have to actually be there to complete it. Objectives without a coordinate stay achievable anywhere.

> **Coordinate convention.** The first number is north-south (north positive, south negative). The second is east-west (east positive, west negative). So `@ -1,0` is one tile south of start, and `@ 0,1` is one tile east. Same convention everywhere positions appear, including the `/debug` modal and `world-stack.json`.

#### Optional: player attributes

Presets can declare immutable player attributes — species, descriptors, scope-bounded capabilities — that the engine treats as canonical:

```yaml
attributes:
  - normal human abilities
    - cannot lie
  - tattoo of a dove on left shoulder
  - magic
    - can manipulate objects
    - cannot manipulate time
```

Top-level bullets are attributes; sub-bullets (4-space indent) scope the parent. The narrator judges each player action against the scope — `magic / can manipulate objects` lets the player snap a tree limb but denies teleport. `cannot ...` bullets create hard limits even when the parent is permissive. Don't put blank lines inside the `attributes:` block — a blank line ends the list.

The first attribute is conventionally the player's species or class (`normal human abilities`, `vampire`, `crow`, `demon`). The narrator inherits common-sense expectations from the name. Sub-bullets refine: confirm specific powers, add restrictions, override defaults.

The field is optional. Presets without it behave exactly as before — the player is treated as an ordinary mortal human. See `presets/merlin-trial.md` for a full example.

Drop a new `.md` in `presets/` and it'll appear on the title screen on the next page load.

### Architecture

- **Runtime:** Bun — server, bundler, and test runner
- **Server:** `Bun.serve` with WebSocket — `src/server.ts`
- **Web:** React 19, single-file app in `src/web/app.tsx`, served via Bun's HTML import
- **State:** plain JSON file (`world-stack.json`); fine for single-user, but multi-user would need per-user namespacing

### Tests

```bash
bun test
```

Covers the stack, presets, engine prompts, server message handlers, and the API client.

---

## Roadmap

- In-app configuration screen
- Self-building exploration map
- Local Stable Diffusion image generation (maybe)

---

## Known Issues

- **first turn of a game takes a bit.** Yes, but subsequent turns will be speedy. (Working on it)

- **Mild narrative drift on long runs.** The structural drift classes (item retcon, count drift, oscillating entries) are closed. What can still happen on long sessions: the narrator occasionally recycles phrasing or skips an item the player hasn't touched in a while. Less severe than before, but worth flagging.

- **Wrong-noun world-update toasts.** Occasionally the toast surfaces an entry about a different object than the one your action targeted. Extraction latches onto the most recently mentioned noun rather than the action's subject. Observed primarily on the previous local narrator/archivist combo; the current `nvidia/nemotron-3-nano` config may improve this, but it hasn't been verified across a long run.

- **LOCATE objectives complete on tile entry.** When you walk onto a tile that contains a "find / locate / reach the X" target, the deterministic safety net in `stack.ts` marks the objective complete the moment you arrive, before you've looked at or examined the thing. This should require an explicit `look`, `inspect`, or `examine` to fire.

- **Duplicate objective-completion events.** Sometimes the same objective gets credited twice in a single session. Likely caused by the deterministic safety net and the archivist attributing the same change independently, with the `unionAchievedIndices` dedup missing the overlap.

- **Cardinal-only movement.** "Walk to the lander," "head west-by-northwest," and stair phrasings like `up` / `down` stay on the current tile and surface a toast. Use `north`, `south`, `east`, or `west`.

- **No first-class inventory.** Items you "take" stay in the world's established entries. There's no separate inventory data structure or UI. Type `inventory` and the narrator synthesizes a list from the entries it knows about, but specific picked-up items occasionally don't make the synthesis.

> Balance is key. We're working on it. 😅

---

## Recent Changes

- **Per-tile entry scoping — the world stops following you.** Established entries used to be a flat global list, so every prior tile's facts (the broken transmitter at the lander, the rover wreck on the eastern crater rim) got dumped into every narrator prompt regardless of where the player was. The narrator would dutifully drag distant objects into the current scene. Each entry now carries an optional tile tag (or `undefined` = world-scope for premise / atmosphere / relationships), and the narrator only sees entries scoped to the current tile plus world-scope ones. The server tags new entries with the current tile on archivist return; the archivist itself still emits text only, so the LLM isn't asked to classify what's local — server-side deterministic tagging, derived from context the archivist already operates within. Resolves the cross-tile bleed that was making longer sessions feel inconsistent.

- **TTS punctuation normalization at the dispatch boundary.** Em-dashes, curly quotes, and ellipsis chars cause both ElevenLabs and the local Chatterbox sidecar to stumble — audible pauses, weird prosody, the occasional stutter or gibberish run. The Python sidecar already normalized these server-side; ElevenLabs was receiving text raw. Mirrored the same mapping table in `src/tts.ts` and applied it once at the dispatch boundary before the cache hash, so both backends get identical clean input regardless of source. Also added a `Do NOT use emdashes` rule to the narrator prompt so the model produces fewer of them in the first place.

- **`/debug` location memory + correct archivist provider label.** The debug panel now shows a Location Memory section under the last-turn pipeline: the current tile's canonical description, its room objects with states and category, entries scoped to this tile, world-scope entries, and a count of entries scoped to other tiles (i.e., what the new tile-scoping is filtering out of the narrator prompt). Makes it easy to verify the model and the engine agree about a scene. Also fixed the Providers list: the archivist row used to read `local / openai/gpt-4o-mini` regardless of the actual upstream — now it shows the real provider, so OpenRouter routing is visible at runtime.

- **Room state — snuffed things stay snuffed.** Each tile now keeps a structured list of its objects (`name`, `states[]`, `location`, `category`) on top of the existing free-form entries. When you snuff a candle, open a chest, or break a thing, the new state is pinned per-tile and the narrator is told ROOM STATE is canonical — no spontaneous relighting, no chests re-closing themselves between turns. State survives travel: walk three rooms away and back, the candle's still out. Storage is keyed by tile coordinates the same way `places` already is, so `world-stack.json` carries this forward on disk. Category drives eviction priority (items and characters pinned, features evicted first) with a deterministic safety net that restores objects the archivist drops if they're named in an active objective. Spec at [`docs/superpowers/specs/2026-05-15-room-state-design.md`](docs/superpowers/specs/2026-05-15-room-state-design.md).

- **Provider keep-alive and startup probes.** Boot now sends a 1-token chat completion to every unique `(provider, model)` your three stages reference, in parallel. If any probe fails — bad API key (`check OPENROUTER_API_KEY`), missing credits (`OpenRouter out of credits`), unreachable LM Studio (`connect refused at http://localhost:1234: is LM Studio running?`), unloaded model (`` model "X" not loaded in LM Studio — load it via the UI or `lms load` ``) — the server prints a per-stage hint that names which pipeline stages share that target, then exits before opening the port. Once probes pass, a 60-second keep-alive ping keeps each connection warm at the provider edge, so the first turn doesn't pay TLS handshake or model-load cold-start costs. Replaces the prior narrator-only OpenRouter warmup; now uniformly covers narrator, archivist, and interpreter regardless of provider.

- **Image gallery + lightbox.** New `/gallery` slash command opens a wide modal listing every image in the server's `media/` directory: big preview on top, prev/next arrows, a scrolling thumbnail strip below, and ← / → keys + ESC. Each turn's generated image gets a ★ button to save it to the gallery in one click — no more right-click-save-as. Anywhere an image appears (turn card or gallery), clicking it opens a fullscreen lightbox at the image's true resolution. Useful since the timeline view crops images to a cinematic strip by CSS, but the underlying frame is square; the lightbox shows what the model actually rendered.

- **Fully local play, properly.** New `LM_STUDIO_URL` env var lets you point at a non-default LM Studio instance, including custom port, host, or basic auth. New `LOCAL_MODEL` plus per-stage `LOCAL_NARRATOR_MODEL` / `LOCAL_ARCHIVIST_MODEL` / `LOCAL_INTERPRETER_MODEL` let you route each pipeline stage independently. For example, a fast 3B model on the narrator paired with a 12B model on the archivist so LOCATE objectives still fire. The narrator prompt also got a new "ending examples" block that helps smaller models follow the rules — no more trailing "What do you examine first?" closers. The bake-off behind all of this lives at [`docs/local-narrator-bake-off.md`](docs/local-narrator-bake-off.md).

- **Better startup and runtime diagnostics.** Boot validates that `NARRATOR_PROVIDER` / `INTERPRETER_PROVIDER` are valid values and exits with a clear message if a Gemini provider is set without `GEMINI_API_KEY`. The web UI also stops auto-firing TTS / image requests when the server reports the key is missing: one toast on first failure, then silence, instead of repeated console errors. The `/debug` pane shows each pipeline stage's actual model (e.g. `narrator: local / mistralai/ministral-3-3b`, `archivist: local / google/gemma-3-12b`), so routing is visible at runtime.

- **`/debug` command.** Type `/debug` in the chatbox to open a modal showing live world state and the last turn's full pipeline: interpreter classification, raw archivist output, entries, threads, `achievedObjectiveIndices`, `moved`, `locationDescription`, and provider info. This is the diagnostic surface that made most of the recent narrative-quality work traceable.

- **Spatial and content discipline.** Cardinal moves are tile transitions, not in-scene steps. `north` from the lander cabin takes you outside on the regolith, not to a back wall. Items established in the world — especially preset-seeded ones — are surfaced by name in the prose, not via vague descriptors the player can't reference back. When an active "Find / Locate / Reach" objective names an item that's at your tile, the narrative produces the named target: no substitution with alternative objects, no preemptive denial of presence. Action-verb objectives ("Send", "Restore", "Repair") still require depicted action, not just arrival.

- **Archivist hardening.** Three classes of objective-completion misfires were fixed: atmospheric clues no longer mark "find out X" objectives complete; static state descriptions ("the chest gapes open") no longer mark "open X" objectives complete; cumulative-stack inference is blocked. Completion now requires the narrative to depict the moment of change or discovery this turn. Stack supersession also tightened: when you take, place, break, or change an item, or a count drops (3 candles → 2), the entries list updates instead of accumulating outdated facts. Established entries that aren't mentioned in a given turn's narrative are preserved unchanged. Absence is not invalidation.

- **Anti-retcon rule.** The narrator can't invent offscreen backstory or false memories ("you remember leaving the key upstairs in the alchemist's study") to delete an established item. Items leave the world only through depicted on-screen action this turn: the player taking, breaking, or using them, or an NPC depicted on-screen doing the same.

- **Blocked-move feedback.** When your input looks like movement but doesn't name a cardinal direction (`go to the train`, `walk to the lander`, `follow the path`), the world now tells you instead of silently improvising. A toast appears with the cardinal directions to try, your input stays in the box for editing, and no turn is consumed. Pure non-movement actions (`examine`, `wait`, `talk`) are unaffected.

---

## License

MIT — see [LICENSE](./LICENSE)
