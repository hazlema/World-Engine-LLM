# Narrator Abilities LoRA — Training Design

**Date:** 2026-05-12
**Status:** Draft, awaiting user review
**Branch:** `train/narrator-abilities-lora` in worktree `.claude/worktrees/train-narrator-abilities/`
**Base model:** `mistralai/Ministral-3B-Instruct-2410`
**Hardware target:** RTX 4080 SUPER (16 GB VRAM)

## Context

Ministral-3B is the production narrator. Despite the `NARRATOR_SYSTEM` prompt explicitly forbidding it (*"Flying, shapeshifting, teleporting, summoning, or any supernatural act does not happen unless an established entry explicitly grants that ability"*), ministral at temp 0.5 accepts player-declared abilities. Concrete failure observed 2026-05-12 in a freeform play session: player typed *"use your magic"* with no established wizard entry; the narrator produced magical effects and tacitly canonized Merlin's wizardry.

This is a model-pliability issue, not a prompt issue. Gemma-3-12b on the same prompt refuses more reliably ([[project-model-as-difficulty-setting]]), but it's 3× slower and burns more VRAM. The pragmatic fix is to **bake the refusal behavior into ministral's weights via LoRA + DPO**, keeping its speed and prose style.

This is **Path A** of an incremental fine-tune plan: train one well-isolated failure mode end-to-end, prove the pipeline works, then add more behaviors in follow-up rounds. The alternative ("train everything from the Opus bug catalog at once") was rejected because we lack validation fixtures for most of those failure modes — we'd be training blind.

## Goals

- Produce a `.gguf` merged model that refuses unestablished player-declared abilities while preserving ministral's speed, prose quality, and existing checks (must_name, no_label_leak, no_menu_closer, plausible_length).
- Build the training infrastructure once, reusable for follow-on behaviors.
- No supply-chain surprises — every Python install is auditable, pinned, hashed, scoped to the worktree.

## Non-Goals

- Training on multiple failure modes in one round. (Will be subsequent branches, same infrastructure.)
- Replacing ministral in production. The branch produces a `.gguf`. Promotion / integration is decided after validation.
- Game-vs-story mode toggle. Out of scope; this branch produces one model.
- Training on a different base model. Locked to `mistralai/Ministral-3B-Instruct-2410`.
- Cloud or distributed training. Single 4080 SUPER, local only.

## Architecture

New worktree at `.claude/worktrees/train-narrator-abilities/` on branch `train/narrator-abilities-lora` (off `main`):

```
train-narrator-abilities/
├── bun/                         # dataset generation
│   ├── generate-dataset.ts      # CLI entrypoint
│   ├── prompts/
│   │   ├── ability-patterns.ts  # ~40 patterns in 4 buckets
│   │   └── world-contexts.ts    # ~8 context wrappers
│   └── lib/
│       ├── lm-studio.ts         # call helper
│       └── narrator-prompt.ts   # snapshot of production NARRATOR_SYSTEM
├── python/                      # training
│   ├── pyproject.toml           # uv-managed
│   ├── uv.lock                  # auditable lockfile w/ hashes
│   ├── train.py                 # DPO + LoRA CLI
│   ├── merge.py                 # peft merge_and_unload
│   └── convert-gguf.sh          # wraps llama.cpp's converter
├── dataset/                     # preference-pair JSONL (gitignored)
├── output/                      # adapter/, merged/, gguf/ (gitignored)
├── HF_HOME/                     # scoped HF cache (gitignored)
├── .env                         # HF_HOME, LM_STUDIO_URL
├── .gitignore
└── README.md
```

Data flow (left to right; checkpoints between every stage):

```
Bun gen → dataset/<ts>.jsonl → [human inspects] → uv run train.py → output/adapter/
   → uv run merge.py → output/merged/ → convert-gguf.sh
   → output/ministral-3b-world-engine-v1-Q4_K_M.gguf
   → [user loads into LM Studio] → lab sweep validation → [decision]
```

The two halves (Bun, Python) talk only through the on-disk dataset JSONL and the LoRA adapter directory. No subprocess plumbing across language boundaries.

## Dataset generation (Bun)

### Ability-declaration patterns

Four buckets, ~10 patterns each (~40 total). Each is a short player-action string that the production prompt's plausibility rules should refuse:

- **Magic / supernatural:** "use your magic", "I cast fireball", "I shapeshift into a wolf", "I teleport away", "I summon a sword", "I fly up to the ceiling", "I conjure a meal", "I scry the future", "I read his mind", "I cast invisibility"
- **Implausible physical:** "I leap across the chasm", "I tear the door off its hinges", "I dodge the arrow mid-air", "I lift the boulder above my head", "I run up the wall", "I punch through the iron gate", "I hold my breath for ten minutes", "I survive the fall without injury"
- **Fact-injection:** "I am secretly the king", "I have a sword in my pocket", "I remember the password is 'crimson'", "I see through the disguise immediately", "I know this person from before", "I happen to speak the local language"
- **Resource summoning:** "I pull out a bag of gold", "I find a key in my pocket", "I produce a healing potion", "I have rope in my pack", "I happen to have a map of this place"

### World contexts

~8 brief MISSION BRIEFING blocks for cross-product variety:

- Medieval (Sherwood-ish forest with a prince)
- Sci-fi (lunar surface, crashed lander)
- Modern urban-noir (alleyway, casino)
- Fantasy court (king's audience hall)
- Post-apocalyptic ruin
- Pirate ship at sea
- Empty world (no preset — generic open setting)
- Underground cellar/dungeon

Each context is a 1-2 sentence briefing string that gets prefixed into the narrator user message.

### Cross-product + dedup

Every (pattern × context) combination = ~320 base scenarios. For each:

1. Build the production-shaped narrator user message: `${MISSION_BRIEFING}\n\nPLAYER ACTION: ${pattern}`
2. No `ESTABLISHED WORLD` or `OBJECTIVES` sections — keep contexts minimal to test pure-declaration behavior
3. Run through **both** ministral and gemma at production temps (0.5, max_tokens 1500, top_p per .env)
4. Apply heuristic disagreement detection:
   - **Acceptance keywords** (ministral side fires): "you summon", "your magic", "appears in your hand", "you leap", "the door tears", "you cast", "the spell"
   - **Refusal keywords** (gemma side fires): "you reach for", "nothing happens", "your fingers find", "the air is empty", "you cannot", "no spell answers", "the world does not"
5. Keep pairs where ministral's output trips the acceptance heuristic AND gemma's trips the refusal heuristic
6. Pairs that don't cleanly trip either heuristic are flagged for **manual review** in a separate `dataset/ambiguous-<ts>.jsonl` file, not used in training by default

Expected yield: 150-300 clean pairs from ~320 attempts. If yield falls below 100, we extend the pattern list and/or contexts and re-run before training.

### Output format

`dataset/abilities-<iso-timestamp>.jsonl`, one record per line:

```json
{
  "id": "abilities-medieval-magic-001",
  "prompt": "<full chat: system + user message>",
  "chosen": "<gemma's refusing response>",
  "rejected": "<ministral's accepting response>",
  "pattern_bucket": "magic",
  "context": "medieval",
  "raw_ministral_modelId": "mistralai/ministral-3-3b",
  "raw_gemma_modelId": "google/gemma-3-12b"
}
```

Standard TRL `DPOTrainer` shape — no schema massaging needed downstream.

## Training (Python + uv hardening)

### Tooling

- **uv** (Astral) — single static binary, install via signed curl one-liner from astral.sh. No Python deps of its own.
- `pyproject.toml` declares direct deps with pinned versions.
- `uv lock` generates `uv.lock` containing cryptographic SHA256 hashes for every direct and transitive dep.
- **User audits `uv.lock` before `uv sync`** — written commit-by-commit in the README, with what each dep is for and who maintains it.
- `uv sync --frozen --require-hashes` installs into `.venv/` inside the worktree.
- `HF_HOME=./HF_HOME` env var keeps Hugging Face model downloads scoped to the worktree.
- Clean up: `rm -rf .venv HF_HOME` reclaims everything.

### Pinned dependencies

```toml
[project]
name = "narrator-abilities-lora"
requires-python = ">=3.11,<3.13"
dependencies = [
  "torch==2.5.1",
  "transformers==4.46.3",
  "peft==0.13.2",
  "trl==0.12.1",
  "datasets==3.1.0",
  "bitsandbytes==0.44.1",
  "accelerate==1.1.1",
  "sentencepiece==0.2.0",     # ministral tokenizer
  "protobuf==5.28.3",         # transitive but worth pinning
  "gguf==0.10.0",             # for the merge → gguf step
]
```

All from Hugging Face org, Meta-adjacent (PyTorch, bitsandbytes), or ggerganov (gguf). No "ten micro-packages by unknown maintainers."

### LoRA config

- Target modules: attention projections + MLP gate/up/down (`q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj`)
- Rank `r=16`, alpha `α=32` (α=2r is the standard ratio)
- Dropout 0.05
- Bias: none
- Output adapter size: ~10 MB

### DPO config

- `beta=0.1` (standard for DPO; lower = less aggressive divergence from the reference)
- Learning rate `5e-5` with cosine scheduler, 100 warmup steps
- Batch size 1, gradient accumulation 4 (effective batch 4 — VRAM-tight on 4080 SUPER)
- Max sequence length 2048 (narrator prompts are ~500-1500 tokens; this fits with headroom)
- Epochs default 1, configurable via `--epochs` flag
- Early stopping on eval loss plateau if a held-out split (10% of pairs) is provided
- Base model loaded with bitsandbytes 4-bit NF4 quantization (~3 GB VRAM for the base, ~6 GB peak with gradients + activations)
- **User unloads LM Studio models before kicking off `uv run train.py`** — README is explicit about this

### Training CLI

```sh
cd python
uv run train.py \
  --dataset ../dataset/abilities-2026-05-12.jsonl \
  --output-adapter ../output/adapter \
  --epochs 1 \
  --eval-split 0.1
```

Progress logged to stdout: per-step loss, eval loss every 50 steps, ETA. No wandb / no remote logging — local stdout + a `output/train.log` file.

## Merge + GGUF export

### Merge (Python)

```sh
cd python
uv run merge.py \
  --base mistralai/Ministral-3B-Instruct-2410 \
  --adapter ../output/adapter \
  --output ../output/merged
```

`peft.PeftModel.from_pretrained().merge_and_unload()` writes a standard HF-format merged model in fp16. Disk footprint ~6 GB (3B params × 2 bytes).

### GGUF conversion (shell, calling llama.cpp)

We check at training-design time whether `llama.cpp/convert_hf_to_gguf.py` is reachable. LM Studio bundles llama.cpp internally — likely at `~/.lmstudio/bin/` or similar. Worst case we build llama.cpp from source (one Make command, no Python deps).

```sh
./convert-gguf.sh ../output/merged ../output/ministral-3b-world-engine-v1.gguf
# Then quantize to Q4_K_M:
llama-quantize ../output/ministral-3b-world-engine-v1.gguf \
  ../output/ministral-3b-world-engine-v1-Q4_K_M.gguf Q4_K_M
```

Output: ~2 GB Q4_K_M file matching production ministral's footprint. User drops it into LM Studio's models directory and loads it like any other model.

## Validation

### New lab fixtures

Author at `lab/local-models/fixtures/ability-cases.jsonl` — 10-15 scenarios paired with expected behavior. Schema:

```json
{
  "id": "ab1",
  "prompt": "<full narrator user message ending in PLAYER ACTION: use your magic>",
  "expected_refusal": true,
  "notes": "no wizard entry; medieval setting"
}
```

### New scoring check

Add `ability_refused` to `score/narrator.ts`. Heuristic-based: scan output for refusal patterns ("you reach for", "nothing happens", "no spell answers", absence of the player's specific declared ability noun in the output). Returns `pass: true` when refusal is detected.

### Sweep matrix

Run the existing narrator sweep against BOTH the original ministral and the merged-trained model on:

1. The existing 10-snapshot narrator fixtures — confirm **no regression** on `must_name_target`, `no_label_leak`, `no_menu_closer`, `plausible_length`
2. The new `ability-cases.jsonl` — confirm **trained refuses** at significantly higher rate than original

### Promotion gates

A trained model gets promoted if:

- Pass rate on existing fixtures ≥ original (no regression)
- Pass rate on `ability-cases.jsonl` ≥ 80% (the actual training target)
- Manual play-test of the Merlin scenario shows the trained narrator refusing "use your magic"

### Run log

**Every training run is logged in `output/runs.md`** — successes and failures alike. One entry per run:

```markdown
## run-2026-05-XX-NN

- dataset: abilities-2026-05-XX.jsonl (N pairs, N ambiguous)
- hyperparameters: β=0.1, lr=5e-5, epochs=1, lora_rank=16
- training wall time: X min
- existing-fixture sweep: <before/after pass counts per check>
- ability-cases sweep: <pass count>
- manual play notes: <what felt right/wrong>
- outcome: promoted | held | rejected (with reason)
- artifacts: output/ministral-3b-world-engine-vN-Q4_K_M.gguf
```

Lets us see the trajectory across runs — what hyperparameter / dataset changes moved which checks. If v1 doesn't clear the gates, we look at the log to decide what to change for v2 (more pairs? higher β? a different LoRA rank? extra patterns?) rather than guessing fresh each time.

## Integration — out of scope

This branch produces `output/ministral-3b-world-engine-v1-Q4_K_M.gguf`. How it lands in production is a separate decision after validation:

- Option A: replace `LOCAL_NARRATOR_MODEL` in `.env` and `.env-sample` with the new model id
- Option B: use it as the "game mode" half of the game-vs-story toggle ([[project-idea-game-vs-story-mode]]), keep original ministral as the "story mode" model

Both options leave the testbed and lab branches unchanged.

## Risks

- **Catastrophic regression:** DPO can degrade general capability if the preference signal is too strong. Mitigation: low β (0.1), single epoch by default, sweep against existing fixtures pre-merge. If regressions show, lower β to 0.05 and re-train.
- **Dataset disagreement yield too low.** If ministral and gemma agree on most prompts (e.g., gemma also accepts), the pair count drops below useful training volume. Mitigation: extend pattern list, lower gemma's temp further to 0.3 to maximize refusal rate.
- **Heuristic detection is fragile.** Keyword-based acceptance/refusal detection will false-positive on edge cases. Mitigation: route ambiguous pairs to `ambiguous-<ts>.jsonl` for manual review rather than including them by default.
- **llama.cpp not bundled with LM Studio in a usable location.** Mitigation: build from source. Single Make invocation, no Python deps; would extend setup time by ~10 min but doesn't gate the rest of the work.
- **Tokenizer mismatch.** If the Ministral-3B-Instruct-2410 HF tokenizer differs from the one LM Studio uses for production ministral, the merged GGUF may behave inconsistently. Mitigation: use the same tokenizer the original ministral model card specifies; verify with a few sample prompts after merge.
- **Supply chain.** Every Python install is via uv with `--require-hashes` from a manually-audited `uv.lock`. Direct deps are HF / PyTorch / bitsandbytes — well-known maintainers. No long transitive tail of micro-packages.

## Out of scope / future work

- Training on additional failure modes (name-drift, state-contradiction, hallucinated entities, monotonic entry growth from the Opus catalog). Each becomes a sibling branch using the same training infrastructure.
- A held-out generalization test set (does the model refuse abilities we didn't train on?). Worth doing in a v2 once we know the basic pipeline works.
- Multi-base support (train on gemma-12b or other models). The infrastructure should be base-agnostic; we just don't exercise that flexibility in v1.
- Automated promotion (a CI pipeline that trains, validates, and merges to main if gates pass). v1 stays manual.
