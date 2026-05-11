# Local-models probe — findings

Tally of probe runs against `fixtures/play-log.jsonl` turn 1
("look around" at position [0,0]) unless noted otherwise.

`prompt_tokens` is roughly constant per turn (the system prompt is the big
chunk — ~1.8k tokens for this fixture).

## qwen/qwen3.6-35b-a3b

LM Studio's OpenAI-compatible endpoint surfaces this model's chain-of-thought
as a **separate `reasoning_content` field** on the response message — so no
`<think>` tag stripping is needed. `content` arrives clean.

| run | think | preserve | ctx | wall (s) | completion tok | reasoning tok | words out | notes |
|-----|------:|---------:|----:|---------:|---------------:|--------------:|----------:|-------|
| 1   | on    | —        | ?   | (not timed) | 1095 | 827  | ~210 | clean narrative; loose-panel hook |
| 2   | off   | —        | ?   | (not timed) | 198  | 0    | ~165 | tighter prose; dust-trail hook |
| 3   | off   | —        | ?   | 2.7      | 97   | 0    |  74  | shorter again — generation varies |
| 4   | on    | —        | ?   | 39.4     | 1500 (capped) | 1499 | **0** | **failure mode** — burned full budget on reasoning, empty content |
| 5   | on    | yes      | 4k  | 39.5     | 1500 (capped) | 1499 | **0** | **same failure as run 4** — preserve-thinking doesn't help here |

## supergemma4-26b-uncensored-v2 (non-thinking)

| run | think | preserve | ctx | wall (s) | completion tok | reasoning tok | words out | notes |
|-----|------:|---------:|----:|---------:|---------------:|--------------:|----------:|-------|
| 6   | n/a   | —        | 4k  | 4.5      | 123 | 0 | 98 | clean; rover-glint hook; atmospheric but a touch generic |

### Observations

- Same ~36-40 tok/s generation rate as qwen3.6-35b-a3b thinking-off, so latency parity per-token.
- Prose is more "generic atmospheric" than qwen's thinking-off pass (which gave concrete details like heat-shield scorch marks and a beeping comms panel). Both follow the narrator rules; qwen felt more cinematic.
- Doesn't surface a NEW event/NPC/sound the way the system prompt asks for ("React to THIS specific action ... make something new happen"); the response is mostly re-describing what's there.
- Bigger model (26B vs ~35B-A3B) but a fraction of the parameter cost since supergemma is dense gemma3 architecture, not MoE.

## nvidia/nemotron-3-nano-omni (thinking, MoE 30B/3B active)

| run | think | preserve | ctx | wall (s) | completion tok | reasoning tok | words out | notes |
|-----|------:|---------:|----:|---------:|---------------:|--------------:|----------:|-------|
| 7   | on    | —        | 4k  | 29.0     | 892 | 787 | 73 | clean — introduces NEW elements (toolbox, rolling bolt); bounded reasoning |
| 8   | off   | —        | 4k  | **7.7**  | 230 | 0   | **167** | **strongest result so far** — explicitly references "damaged transmitter half-buried in regolith" from world-stack |

### Observations

- **Best-quality output so far on turn 1, in either mode.** Run 8 (think-off) named a fixture-canonical item by its established noun ("the damaged transmitter half-buried in regolith") — the only model to do that. Run 7 (think-on) introduced new entities (rust toolbox, rolling bolt) the world-stack didn't have, which is also good but a different flavor.
- **Reasoning is disciplined, not a spiral.** Nemotron's CoT reads like a checklist ("must be under 250 words, end with something concrete...") instead of R1-style self-debate. So thinking-on doesn't blow the budget like qwen3.6-a3b did.
- **Think-on (29s) is a deal-breaker for interactive play; think-off (7.7s) is acceptable.** Pick mode based on use case.
- **Reasoning is surfaced via `reasoning_content` field** (same path as qwen3.6-a3b through LM Studio) — no inline `<think>` tags.

## google/gemma-4-e2b (4.6B, gemma4)

| run | think | preserve | ctx | wall (s) | completion tok | reasoning tok | words out | notes |
|-----|------:|---------:|----:|---------:|---------------:|--------------:|----------:|-------|
| 9   | auto  | —        | 4k  | **2.5**  | 408 | 303 | 84 | fastest. Uses thinking but disciplined; output atmospheric, doesn't introduce new entities |

### Observations

- **Fastest model tested.** 2.5s end-to-end including ~300 reasoning tokens. Generation rate is the bottleneck for everything else.
- **Reasoning surfaced in `reasoning_content`** — gemma4 plays nice with LM Studio's separator.
- Quality is okay but not standout — atmospheric, ends with a hook ("faint intermittent signal from the eastern rise"), but doesn't react with new events the way the system prompt asks.
- **Budget option** if latency is the dominant concern.

## google/gemma-3-12b (12B, gemma3 — your prior baseline)

| run | think | preserve | ctx | wall (s) | completion tok | reasoning tok | words out | notes |
|-----|------:|---------:|----:|---------:|---------------:|--------------:|----------:|-------|
| 10  | n/a   | —        | 4k  | 3.1      | 158 | 0   | 123 | non-thinking; introduces multiple new elements (cracked seal, glint, rhythmic whine, "battered data slate") |

### Observations

- **The current baseline holds up well.** Multiple genuinely new entities, atmospheric without being purple, ends with a clear interactable (the data slate).
- Plays "trick of the light" with the rover ("seems subtly closer than before") — subtle, in-character narrator voice.
- Non-thinking model, no `<think>` complication.
- Solid all-rounder.

## microsoft/phi-4-reasoning-plus (15B, Phi-3 arch)

| run | think | preserve | ctx | wall (s) | completion tok | reasoning tok | words out | notes |
|-----|------:|---------:|----:|---------:|---------------:|--------------:|----------:|-------|
| 11  | auto  | —        | 4k  | 5.8      | 308 | 0   | 247 | **breaks the narrator rules** — see observations |

### Observations

- **Breaks core rules of the narrator prompt.** Uses **3rd person** ("The player's gaze sweeps") instead of 2nd person ("your"). Uses **forbidden RPG-style asides** ("What lies just out of reach?", "Focus on one thing:"). Leaks **prompt-structure meta** ("prior mission briefings", "previous explorers").
- Quality is the worst of any model tested. Despite the "reasoning" branding, no reasoning tokens were reported — phi-4 here behaves like a non-thinking model through this API.
- Verbose (~247 words, right at the cap) but says less than gemma-3-12b's 123 words.
- **Not viable** for this narrator role without significant prompt re-engineering. Skip.

## zai-org/glm-4.7-flash (30B, DeepSeek 2 arch) — discovered accidentally

| run | think | preserve | ctx | wall (s) | completion tok | reasoning tok | words out | notes |
|-----|------:|---------:|----:|---------:|---------------:|--------------:|----------:|-------|
| 12  | on    | —        | 4k  | **48.2** | 1077 | 922 | 115 | beautiful prose but **slowest tested** |

### Observations

- LM Studio refused to load `qwen/qwen3.6-27b` (probably VRAM) and silently fell through to whatever was loaded — turned out to be `zai-org/glm-4.7-flash`, which we hadn't tested yet.
- **Quality is excellent** — concrete details ("primary hatch hangs open on twisted hinges, revealing a pitch-black void where life support systems used to reside"), atmospheric, ends with two clear interactables (blinking red beacon, manual crank handle).
- **48 seconds is unplayable.** ~22 tok/s gen rate is similar to others, but the model thinks for 922 tokens before generating.
- Worth re-testing with thinking off to see if quality holds and speed becomes reasonable.

## qwen/qwen3.6-27b (27B dense)

| run | think | preserve | ctx | wall (s) | completion tok | reasoning tok | words out | notes |
|-----|------:|---------:|----:|---------:|---------------:|--------------:|----------:|-------|
| —   | —     | —        | 4k  | —        | —              | —             | —         | **failed to load** — likely VRAM limit |

### Observations

- `lms load qwen/qwen3.6-27b --gpu max --context-length 4096` → "Failed to load model".
- 27B dense is bigger than what fits alongside other things on this hardware.
- May need a smaller context (1024?) or a quantized variant to test.

## mistralai/ministral-3-3b (3B, mistral3)

| run | think | preserve | ctx | wall (s) | completion tok | reasoning tok | words out | notes |
|-----|------:|---------:|----:|---------:|---------------:|--------------:|----------:|-------|
| 13  | n/a   | —        | 4k  | **1.8**  | 181 | 0   | 120 | very fast, creative (NPC voice from rover) but breaks no-menu rule with trailing "*What do you examine first?*"; uses markdown bold |

### Observations

- **Fastest model tested so far.** ~100 tok/s effective.
- Creative — introduces a disembodied NPC voice that no other model attempted, plus interesting new entities (cracked glass panel, dragged wheel).
- **Breaks the "never offer the player a menu of options" rule** with a trailing question. The `stripNarratorMarkup` function in the real app strips `*` (so the markdown bold would dissolve), but the question itself would still appear.
- Worth experimenting with — at 1.8s the speed budget is so generous you could prompt-engineer around the rule violations.

## mystral-uncensored-rp-7b (7B, Llama)

| run | think | preserve | ctx | wall (s) | completion tok | reasoning tok | words out | notes |
|-----|------:|---------:|----:|---------:|---------------:|--------------:|----------:|-------|
| 14  | n/a   | —        | 4k  | 1.4      | 132 | 0   | 99  | **leaks position tag** "(0,0)" into prose; ends with purple meta ("may hold the key to uncovering the secrets"); ignores established lander/rover entities |

### Observations

- Even faster than ministral (1.4s) but quality is poor.
- Leaked the literal "(0,0)" position tag from the prompt into the narrative — a sign the model isn't separating system from narration well.
- Generic mysticism instead of concrete description; doesn't reference the canonical lander or rover at all.
- **Skip** for narrator role. The "rp" in the name (roleplay) and "uncensored" suggest a different purpose entirely.

## liquid/lfm2-24b-a2b (MoE 64x1.3B, lfm2moe)

| run | think | preserve | ctx | wall (s) | completion tok | reasoning tok | words out | notes |
|-----|------:|---------:|----:|---------:|---------------:|--------------:|----------:|-------|
| 15  | n/a   | —        | 4k  | 1.7      | 281 | 0   | 201 | creative (thermal bloom, glassy stone flecks) but **explicit menu of options** at end |

### Observations

- Fast (1.7s) for the longest output yet (201 words).
- Introduces multiple new elements: thermal bloom 20m north, glassy stone flecks, hatch yawning open.
- **Breaks the no-menu rule explicitly**: "What do you examine first? The toolbox on your belt, the shimmer ahead, or the lander's open hatch?" — the exact forbidden phrasing.
- Has internal contradictions ("rests near your boots, clipped to your belt").
- Promising raw capability if the rule violations can be prompt-engineered away.

## mistralai/devstral-small-2-2512 (24B, mistral3)

| run | think | preserve | ctx | wall (s) | completion tok | reasoning tok | words out | notes |
|-----|------:|---------:|----:|---------:|---------------:|--------------:|----------:|-------|
| 16  | n/a   | —        | 4k  | 5.9      | 203 | 0   | 141 | **names "damaged transmitter" from world stack**; minor lunar/dust-devil continuity issue |

### Observations

- **Second model after nemotron-think-off to name a world-stack item by its canonical noun** ("a damaged transmitter, its antenna bent but recognizable").
- Adds a "what just changed" beat — comms static interfering with transmission.
- One factual continuity issue: mentions "dust devils swirl lazily" on what is clearly a lunar-like setting (the rest of the prose has airless/vacuum cues). The model didn't quite anchor on "no atmosphere" the way the world should require.
- Ends with a bracketed/italic line `*The damaged transmitter lies half-buried to the east.*` — borderline "system summary" feel, but not a forbidden menu.
- 5.9s is in the same latency tier as nemotron-think-off, with comparable quality.

## Untested

- `zai-org/glm-4.7-flash` with thinking off — needs LM Studio UI toggle to retest
- `qwen/qwen3.6-27b` — fails to load even at ctx=2048 on this hardware; skip

## Overall standings (turn 1, "look around" at [0,0])

Ranking weights world-stack-aware narration ("uses the canonical state instead of inventing parallel facts") above raw speed, because the narrator's job is to honor the established world.

### ✅ Top tier — recommended

| rank | model | wall | quality |
|-----:|------|-----:|---------|
| 1 | nvidia/nemotron-3-nano-omni (think-off) | 7.7s | **names world-stack item by canonical noun**; rich detail; introduces new events |
| 2 | mistralai/devstral-small-2-2512 | 5.9s | **names world-stack item by canonical noun**; minor lunar/atmosphere slip |
| 3 | google/gemma-3-12b | 3.1s | multiple new elements (cracked seal, glint, data slate); voicey; the current baseline holds up |
| 4 | qwen/qwen3.6-35b-a3b (think-off) | 2.7s | cinematic (scorch marks, beeping comms); fast |

### ✅ Budget tier — fast but doesn't introduce new events

| rank | model | wall | quality |
|-----:|------|-----:|---------|
| 5 | google/gemma-4-e2b | 2.5s | atmospheric, terse, ends with a hook |
| 6 | supergemma4-26b-uncensored-v2 | 4.5s | re-describes the setting; generic |

### ⚠ Fix-the-prompt tier — capable but breaks rules

| model | wall | issue |
|-------|-----:|-------|
| mistralai/ministral-3-3b | 1.8s | trailing menu question; markdown bold; creative NPC voice though |
| liquid/lfm2-24b-a2b | 1.7s | explicit "What do you examine first?" menu at end; internal contradictions |
| zai-org/glm-4.7-flash (think-on) | 48s | gorgeous prose, too slow; retest think-off |

### ❌ Skip

| model | wall | why |
|-------|-----:|-----|
| mystral-uncensored-rp-7b | 1.4s | leaks `(0,0)` position tag into prose; purple meta |
| qwen/qwen3.6-35b-a3b (think-on) | 40s+ | unreliable — often burns full budget on reasoning, empty content |
| microsoft/phi-4-reasoning-plus | 5.8s | 3rd-person narration ("The player's gaze"), RPG-style asides, prompt-structure leakage |
| qwen/qwen3.6-27b | — | won't load on this hardware (even at ctx=2048) |

## Stress test — turn 18 (richer context)

Turn 18 input: `"I fully uncover the smooth black rock."` at position `[0,5]`.
At this point the play-log has 8 canonical places and 22 entries established.
The probe's simplified slicer sends the position-anchored `places` but NOT the
top-level `entries`, so models still need to bridge the canonical lander/rover
context with the player's specific action.

### Results

| model | wall (s) | words | rock becomes | new entities introduced |
|-------|---------:|------:|--------------|--------------------------|
| `nvidia/nemotron-3-nano-omni` (think-off) | — | — | **couldn't test** — LM Studio worker crashed on load (exit code null); needs LM Studio restart |
| `mistralai/devstral-small-2-2512` (run A, stale state) | 20.9 | 48 | recognized as the canonical `damaged transmitter` | "something moves in the rover wreck's shadow" |
| `mistralai/devstral-small-2-2512` (run B, clean) | 4.4 | 107 | a compact survival kit (energy bar, blanket, oxygen canister) | distress-beacon whine, blinking red light, dark seam south |
| `google/gemma-3-12b` | 3.4 | 126 | obsidian alien artifact w/ pulsing crimson glyph | **named NPC: Anya Volkov, geologist**; geological hammer near rover |

### Observations

- **gemma-3-12b** showed by far the most creative range — first model to introduce a named NPC by name (Anya Volkov), with personality cues ("hasn't spoken to you since the initial survey, her expression unreadable"). Vivid physical description ("grown, like frost on glass"). Sci-fi mystery element on the rock.
- **devstral** has high variance run-to-run: one go recognized the rock as the canonical transmitter (disciplined / world-stack-conservative), another invented a survival cache (creative but doesn't reference canonical items). Both runs were good.
- Neither model broke narrator rules on turn 18 (no 3rd person, no menu of options, no prompt leakage).
- The discoverer-mystery-aesthetic from gemma-3-12b is genre-aligned (lunar sci-fi setting) — alien artifact + arriving NPC is a stronger storytelling beat than "it's a survival kit" or "it's the transmitter you knew about."

### Updated recommendation after stress test

For an interactive narrator with this prompt, the new lean is:

1. **🥇 `google/gemma-3-12b`** — 3.4s, fast, story-rich, introduces named characters and mysteries when the action calls for it. Holds up on both simple (turn 1) and complex (turn 18) inputs.
2. **🥈 `mistralai/devstral-small-2-2512`** — 4.4-5.9s, world-stack-conservative, good for "established world honors itself" play. Best when canonical state should drive reveals.
3. **🥉 `nvidia/nemotron-3-nano-omni` (think-off)** — turn 1 was excellent (named the transmitter); turn 18 untested due to LM Studio crash. Worth retesting after LM Studio restart.

## Recommendation

If you want a single default for the narrator on this hardware, the picks are:

- **For best fidelity to the world stack:** `nvidia/nemotron-3-nano-omni` with thinking **off** — 7.7s, references established items by name. The only model that consistently demonstrates it's reading the canonical state.
- **For best speed/quality balance:** `google/gemma-3-12b` — 3.1s, introduces multiple new events, in-character narrator voice. Solid all-rounder; the current baseline earned it.
- **For cinematic flavor:** `qwen/qwen3.6-35b-a3b` with thinking **off** — 2.7s, vivid detail (scorch marks, broken hull components). Best for an atmospheric, descriptive narrator.

For thinking models in general on this prompt: **thinking-off is the only safe mode** unless you raise `max_tokens` to 3000+ and accept 30-50s per turn. Reasoning models without LM Studio's `reasoning_content` field separation (none observed yet, but expected for DeepSeek-R1-Distill / QwQ) will still need the deferred `--render` stripping mode (Task 9 in the plan).

### Headline findings (so far)

1. **No "translation matrix" needed for this model.** Reasoning lands in its
   own field; `content` is the prose. The `<think>` tag stripping plan only
   matters for models that emit reasoning inline (DeepSeek-R1-Distill, QwQ, etc.).

2. **Thinking-on is unreliable on this prompt at default max_tokens=1500.**
   Run 1 worked; runs 4 and 5 (same model, same prompt) hit the budget wall
   and produced empty content. Variance is high — the first success was luck.
   For an interactive narrator, thinking-off is the only mode safe to ship.

   **Preserve-thinking is not a fix.** Run 5 with preserve-thinking enabled
   produced byte-for-byte the same failure (same wall time, same cap, same
   empty content) as run 4 without it. Preserve-thinking is a multi-turn
   cache for conversation continuity, not a single-turn budget extender.

3. **Thinking-off is fast and consistently good.** ~2.7s wall-clock for ~100
   completion tokens at ~36 tok/s. Prose follows the narrator rules
   (no menu of options, ends with a hook, under 250 words).

4. **Token economy with thinking-off is ~5–10× cheaper** per useful word vs
   thinking-on. For a real-time game loop this is the difference between
   playable and unplayable.

## Open questions

- Does **preserve-thinking** help? (Run 5 will tell.)
- How does **gemma-3-12b** (current baseline) compare on the same prompt
  through this probe?
- How does **a model that emits inline `<think>` tags** (DeepSeek-R1-Distill,
  QwQ-32B) behave? That's where Task 9 (render-mode strip+extract) becomes
  relevant.
- Does the model hold up on a **richer turn** (e.g. turn 18, where the world
  has more established facts and active threads)? Run 1 had near-empty
  context (only one canonical place established).

## Setup notes

- Probe at `.claude/worktrees/local-models/probe.ts`
- `fixtures/play-log.jsonl` turn 1 = `look around` at `[0,0]`
- World-stack fixture has 1 canonical place established for [0,0]
- System prompt ~1.8k tokens; user message ~100-200 tokens
- The probe sends a **simplified** prompt — see README.md
- Defaults: `temperature=0.8`, `max_tokens=1500`

## Postscript — gameplay test (2026-05-11)

After the bake-off, the `v1-endings` prompt variant brought `mistralai/ministral-3-3b` into rule compliance on the probe (no more menu-of-options closer). The prompt change was shipped to `NARRATOR_SYSTEM` in `src/engine.ts` along with a `LOCAL_MODEL` env override, and ministral was tried as the full-pipeline local model in actual play.

**Result: insufficient for preset play.** Observed:
- Narrator did NOT proactively surface the canonical `damaged transmitter` in prose when the player walked onto its tile. The model knew the item existed (it produced a description when the player asked "is there a transmitter here") — but the "surface established items by name" rule is one of 30+ bullets in the prompt, and a 3B model can't track all of them under prompt pressure.
- Archivist (also running on ministral) didn't fire the LOCATE objective when the player typed `look at the transmitter`. Same root cause + structured-JSON output is the riskiest workload for a small model.

**Takeaway:** the probe lab measures narrator quality in isolation on a single turn. Actual gameplay exercises narrator → archivist → interpreter in a feedback loop, and the archivist's structured-JSON extraction is where smaller models break first. **For preset stories with LOCATE objectives, 12B-class is the floor.** Ministral remains interesting for Empty World freeplay (no established items, no LOCATE objectives, narrator's only job is prose) — that's a future experiment.
