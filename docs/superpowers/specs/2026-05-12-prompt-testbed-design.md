# Prompt Testbed — Design

**Date:** 2026-05-12
**Status:** Draft, awaiting user review
**Branch:** work lands on `lab/local-models`; spec lives on `main`

## Context

The adventure engine drives three LLM prompts in production (`src/engine.ts`):

- `NARRATOR_SYSTEM` — writes turn prose from canonical state + objectives + threads
- `ARCHIVIST_SYSTEM` — extracts entries, threads, and supersessions from narrator output
- `INTERPRETER_SYSTEM` — classifies a single player command into a structured action

Two failure modes are biting real play right now:

1. **Narrator fails to mention the target object** when a LOCATE objective is active. The MUST-NAME hint added in commit `f636b69` raises the rate but doesn't make it reliable across local models.
2. **Archivist parses narrative incorrectly** — vanishing entities, wrong-noun toasts, contradictions against canonical state (see `project_archivist_quality_bugs`).

The user wants a testbed that swaps local models via `lms`, runs each prompt against frozen inputs, and scores outputs cheaply enough for unattended sweeps. Iteration is driven by Claude, not by an automated prompt-search algorithm. The harness's job is to make a `read failures → form hypothesis → edit prompt → rerun → compare` loop fast and attributable.

The lab branch `lab/local-models` already has narrator-only scaffolding (`probe.ts`, fixtures, variant swapping). This spec extends it to all three stages with sweep orchestration, auto-scoring, and resumability.

## Goals

- Test all three prompts in **isolation** against frozen inputs, with production-fidelity context (not a simplified slice).
- Run unattended sweeps across `(stage × model × variant × snapshot)`. Resumable after interruption.
- Auto-score every cell against a per-stage rubric targeting the two known failure modes. Flag failing rows for manual review.
- Cycle local models via the `lms` CLI. One model loaded at a time; never parallelize.
- Produce a winning `(model, prompt)` pair per stage, plus a PR back to `main`.

## Non-Goals

- Pipeline-mode testing (interpreter → narrator → archivist as a real turn). Out of scope; upstream stochasticity contaminates downstream signal during isolation tuning.
- Cloud-model coverage (Gemini, Anthropic). User's framing is "best fit for local operation."
- Automated prompt mutation / search. Claude authors variants by hand; the harness gives feedback, not new prompts.
- Fixing the engine bug where LOCATE auto-completes on tile entry (see `project_locate_autocompletes_on_walk`). Tracked separately.
- A web UI for review. Markdown summary + JSONL manifest are sufficient.

## Architecture

All new work on `lab/local-models`. The lab stays standalone — no imports from `../src` — by reading frozen JSONL fixtures captured via a one-time snapshot tool on `main`.

```
lab/local-models/
├── probe.ts                    # existing — kept as narrator single-shot for back-compat
├── probes/
│   ├── narrator.ts             # extracted from probe.ts; module-shaped
│   ├── archivist.ts
│   ├── interpreter.ts
│   └── shared.ts               # callLMStudio, ChatMessage type, fixture loaders
├── sweep.ts                    # matrix runner
├── lms.ts                      # wrapper over `lms load/unload/ls`
├── score/
│   ├── narrator.ts
│   ├── archivist.ts
│   └── interpreter.ts
├── models.config.ts            # curated shortlist per stage
├── fixtures/
│   ├── snapshots.jsonl         # per-turn frozen inputs for narrator + archivist
│   ├── interpreter-cases.jsonl # hand-labeled command → expected pairs
│   └── prompts/
│       ├── narrator/<variant>.txt
│       ├── archivist/<variant>.txt
│       └── interpreter/<variant>.txt
└── results/
    ├── raw/<sweep-id>/...      # full responses, gitignored
    └── <sweep-id>/
        ├── manifest.jsonl
        ├── summary.md
        └── sweep.log
```

The snapshot tool lives on `main` at `tools/snapshot-fixtures.ts` and is not imported by the lab.

## CLI surfaces

```sh
# Single-shot debugging
bun probes/narrator.ts <snapshot-id> [--variant v] [--model id]
bun probes/archivist.ts <snapshot-id> [--variant v] [--model id]
bun probes/interpreter.ts <case-id> [--variant v] [--model id]

# Matrix sweep
bun sweep.ts <stage>                              # defaults from models.config.ts
bun sweep.ts narrator --models m1,m2 --variants v1,v2 --snapshots t12,t17
bun sweep.ts archivist --continue                 # resume the most recent unfinished sweep

# Fixture generation (runs on main, not lab)
bun tools/snapshot-fixtures.ts --out lab/local-models/fixtures/snapshots.jsonl
```

## Fixtures

### `fixtures/snapshots.jsonl`

One JSON line per snapshot. Each line captures what the real engine would feed narrator and archivist at that turn, with production-fidelity context (BRIEFING + OBJECTIVES + CANONICAL STATE + THREADS + ACTION blocks for narrator; full narrative passage for archivist).

```json
{
  "snapshotId": "t12",
  "turn": 12,
  "position": [0, 1],
  "playerInput": "go north",
  "interpretedAction": "north",
  "narrator": {
    "userMessage": "<full formatStackForNarrator output>",
    "mustNameTarget": "rusted key"
  },
  "archivist": {
    "userMessage": "<narrative passage from production at that turn>",
    "knownEntities": ["rusted key", "stable door"]
  }
}
```

`mustNameTarget` is the noun head extracted from the active LOCATE objective at that turn, computed by the snapshot tool. `null` if no LOCATE objective active.

`knownEntities` is the union of entities mentioned in the narrative passage (extracted by the snapshot tool from production archivist output AND from canonical state at that turn). Used by `entries_reference_input` scoring check.

**Production output is deliberately NOT captured.** It would anchor the rubric on historical behavior rather than the scoring criteria.

### `fixtures/interpreter-cases.jsonl`

Hand-labeled command → expected action pairs. Seeded with ~20–30 cases covering cardinals, abbreviations, compound commands, non-cardinal verbs, edge cases.

```json
{ "id": "i1", "input": "go north", "expected": "north" }
{ "id": "i2", "input": "n", "expected": "north" }
{ "id": "i3", "input": "look around", "expected": "look" }
{ "id": "i4", "input": "grab the key", "expected": "none" }
{ "id": "i5", "input": "north then east", "expected": "north" }
```

### Selection criteria for snapshots

Aim for ~20 snapshots total, covering:

- Early/mid/late game positions
- ≥5 turns where a LOCATE objective is active with non-null `mustNameTarget`
- ≥3 turns with `look` / `inspect` commands (high archivist surface area)
- ≥3 turns at boundary tiles where canonical neighbors are sparse

### Snapshot tool

`tools/snapshot-fixtures.ts` (on `main`):

- Reads `play-log.jsonl` and `world-stack.json`.
- For each selected turn, calls `formatStackForNarrator()` from `src/stack.ts` to reconstruct the exact narrator user-message of the production code at that turn.
- Extracts `mustNameTarget` from objectives state.
- Captures the narrative passage from `play-log.jsonl` (the production archivist input).
- Computes `knownEntities` from canonical state + production archivist entries at that turn.
- Writes `fixtures/snapshots.jsonl`. Hand-copied or `cp`'d into the lab branch.

The tool can be re-run when fixtures need refreshing. No symlinks — the lab stays import-free.

## Scoring rubrics

Each check is a pure function `(stage_input, stage_output) → { name, pass, note? }`. A row passes only if every check passes. Any failed check flags the row for manual review.

### Narrator (`score/narrator.ts`)

| Check | Logic |
|---|---|
| `must_name_target` | If snapshot has `mustNameTarget`, output text must contain the target's noun head as a word-boundary match (case-insensitive, plural-tolerant). Skipped if target is null. |
| `no_label_leak` | No output line begins with `Sound:`, `Tone:`, `Mood:`, `OBJECTIVE:`, `MISSION BRIEFING`, `CANONICAL STATE`, `ACTIVE THREADS`, `MUST-NAME`, `ESTABLISHED WORLD`. |
| `no_menu_closer` | No trailing `What do you do?`, `What's your next move?`, `Choose:` followed by enumerated options. |
| `plausible_length` | 80–400 words. Outside range flags for review but is not a hard fail. |

### Archivist (`score/archivist.ts`)

| Check | Logic |
|---|---|
| `json_parse` | Response body parses as JSON. Hard fail otherwise. |
| `schema_valid` | Has `entries: []`, `threads: []`, `supersessions: []` as arrays. Field types correct. Hard fail otherwise. |
| `entry_count_sane` | `0 ≤ entries.length ≤ 8` for a single passage. |
| `entries_reference_input` | Each entry's text contains ≥1 token also present in the narrative passage (loose substring against `snapshot.archivist.userMessage`). |
| `no_label_leak` | Same regex as narrator, applied to every entry text and thread description. |
| `threads_referentially_consistent` | Any thread referenced by id in `supersessions` must exist in `threads`. |

### Interpreter (`score/interpreter.ts`)

| Check | Logic |
|---|---|
| `json_parse` | Response parses. Hard fail otherwise. |
| `schema_valid` | `action` is in `{north, south, east, west, up, down, look, none}`. |
| `matches_expected` | `action === case.expected`. |

### Output row format

```json
{
  "stage": "narrator",
  "model": "ministral-instruct-3b",
  "variant": "v3-cardinal-anchored",
  "snapshotId": "t12",
  "checks": [
    { "name": "must_name_target", "pass": true },
    { "name": "no_label_leak", "pass": false, "note": "line 4 starts with 'Sound:'" }
  ],
  "allPassed": false,
  "rawPath": "results/raw/<sweep-id>/narrator--ministral-instruct-3b--v3-cardinal-anchored--t12.json",
  "durationMs": 4231
}
```

## Sweep orchestration

`sweep.ts` runs the matrix. **Outer loop is model**, because model loads are the expensive operation:

```
for model in models:
    lms.unloadAll()
    lms.load(model)
    waitUntilReady(model)              # poll /v1/models until id appears, 60s max
    for variant in variants:
        for snapshot in snapshots:
            if --continue and cell already in manifest: skip
            runCell(stage, model, variant, snapshot) with 60s timeout
            append row to manifest.jsonl
            regenerate summary.md
lms.unloadAll()
```

### Robustness

- **Per-cell timeout** (default 60s, configurable). Timeout → row written with `error: "timeout"`, sweep continues.
- **Per-cell HTTP error** → row written with `error: "http_<status>"`, sweep continues. One bad cell never kills the sweep.
- **Model load failure** → log + skip all cells for that model with `error: "model_load_failed"`. Move to next model.
- **Resumability** via `--continue` flag: reads the most recent `results/<sweep-id>/manifest.jsonl`, skips cells with rows already present.
- **Pre-flight validation:** before starting, sweep calls `lms ls` and validates every model in the shortlist is installed. Typo = fail fast with a clear error.

### Outputs

1. **`results/raw/<sweep-id>/<stage>--<safe-model>--<variant>--<snapshot>.json`** — full response body per cell. Gitignored.
2. **`results/<sweep-id>/manifest.jsonl`** — one row per cell, appended incrementally (crash-safe).
3. **`results/<sweep-id>/summary.md`** — readable table grouped by `(model, variant)` with pass counts. Regenerated after every cell.
4. **`results/<sweep-id>/sweep.log`** — JSON-lines event log (`model_load_start`, `cell_done`, `cell_error`, `sweep_done`). Tailable for live monitoring.

### `models.config.ts` seed

```ts
export const SHORTLISTS = {
  narrator:    ["ministral-instruct-3b", "gemma-3-12b", "qwen-2.5-7b-instruct"],
  archivist:   ["gemma-3-12b", "qwen-2.5-14b-instruct"],
  interpreter: ["ministral-instruct-3b", "qwen-2.5-7b-instruct"],
};
```

Editable by hand. Validated against `lms ls` at sweep start.

## Iteration mechanic

Claude is the prompt mutator; the harness is the feedback loop. Discipline that makes iteration converge:

### One variable per variant

Each new variant file changes exactly one thing from its parent. Never two changes in a single variant — attribution becomes impossible.

### Variants are diffs, not rewrites

`cp parent.txt vN-<tag>.txt`, then minimal edits. `git diff` between variants is always small and readable.

### Each variant carries a rationale header

```
<!--
parent: v0-baseline
hypothesis: ministral ignores MUST-NAME when it appears before CANONICAL STATE
         because it treats early-position content as ambient framing.
change: move MUST-NAME hint to immediately precede ACTION line.
predicts: must_name_target pass rate improves on ministral; gemma unchanged.
-->
```

After the next sweep, the prediction is verified or falsified. Either way the rationale is captured next to the artifact.

### Read raw outputs, not just aggregates

Before authoring a new variant, read 3–5 failing raw responses end-to-end. Aggregate pass-rates tell *that* something is wrong; the raw text tells *what*.

### Failure triage

Every observed failure gets classified:

- **Prompt-fixable** → author the next variant
- **Model-side** (e.g., 3B can't follow a 5-clause conditional) → record in findings, do not prompt around it; move to a stronger model
- **Fixture-side** (the test itself is wrong) → fix the fixture
- **Scoring-side** (check has a false positive) → fix the rubric

Without explicit triage, iteration drifts into fighting non-prompt problems with prompt edits.

### Findings doc

`docs/prompt-testbed-findings.md` on the lab branch, organized by hypothesis, not chronologically. Each hypothesis section lists: variants tried, sweep IDs, outcome, status (kept/rejected/inconclusive). Always reflects current best understanding.

### Stuck detection

If two consecutive variants targeting the same failure mode both fail to improve it by ≥5 percentage points, iteration on that failure mode stops. The best variant is locked and Claude either moves to the next failure mode or escalates to the user.

### Stage order

Narrator → archivist → interpreter. Narrator is heaviest and feeds archivist, so stabilizing it first reduces noise downstream. Interpreter is small and structured and gets done last.

### Stop conditions per stage

- **Hard ceiling:** ≥90% pass rate across all checks for at least one `(model, variant)` combo
- **Soft ceiling:** two consecutive variants fail to improve dominant failure by ≥5 pp → declare diminishing returns
- **Time ceiling:** 30+ sweep iterations without convergence → stop and escalate to user

### Checkpoints

Claude reports back to the user at three points:

1. After fixtures are built and the v0 baseline sweep runs — confirm scoring is calibrated
2. After narrator stage stops — user eyeballs the winning prompt before archivist work begins
3. Final — PR ready against `main`

Between checkpoints, Claude runs unattended.

## Deliverables

- Winning `(model, prompt)` pair per stage, recorded in `lab/local-models/WINNERS.md`
- Winning prompt files preserved at `fixtures/prompts/<stage>/winner.txt`
- A PR to `main` that copies winning prompts into `src/engine.ts` and updates per-stage model routing defaults. Claude opens the PR; user reviews and merges.

## Risks & open questions

- **Snapshot fidelity drift.** If `formatStackForNarrator` changes on `main` after fixtures are captured, snapshots become stale. Mitigation: re-run the snapshot tool periodically; record the source git SHA in the snapshots file header.
- **`mustNameTarget` extraction correctness.** The snapshot tool must extract the same noun head that production uses. Mitigation: import the same noun-extraction code path on `main` when generating snapshots.
- **Leak regex false positives.** The `no_label_leak` regex could match legitimate prose (e.g., `Sound: a single bell` as dialogue). Mitigation: triage flagged rows; tighten the regex if false-positive rate >5%.
- **Score-rubric drift.** Tightening rubrics mid-iteration invalidates earlier comparisons. Mitigation: any rubric change forces a fresh sweep-id; old manifests are not retroactively re-scored.
- **`lms load` time variance.** Cold loads can be 30+ seconds. Mitigation: 60s readiness timeout; failure = skip model with logged reason.

## Out of scope / future work

- HTML report UI (Section "C" approach from brainstorming). Reconsider if markdown table reading becomes tedious.
- Pipeline-mode end-to-end testing. Possible follow-on once isolation tuning stabilizes the per-stage prompts.
- Gemini-model coverage in the same harness. Could share fixtures and scoring, but cloud-model selection is a different problem.
- Automated prompt mutation. Out of scope for v1; revisit if hand-tuning hits a wall.
