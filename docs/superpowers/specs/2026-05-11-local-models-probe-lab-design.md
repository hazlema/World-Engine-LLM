# Local Models Probe Lab — Design

**Date:** 2026-05-11
**Branch:** `lab/local-models` (orphan)
**Worktree:** `.claude/worktrees/local-models/`

## Purpose

A throwaway exploration sandbox for finding a "decent" local model — including
thinking models whose useful output lands inside `<think>...</think>` blocks
rather than the post-thinking response. The lab is isolated from the main app
(orphan branch, no shared code) so it can be deleted without ceremony if it
doesn't pan out.

## Scope

**In scope**
- Single-turn probe against whatever model is currently loaded in LM Studio
- Raw, stringified response dumped to stdout and a per-run text file
- Self-contained fixtures (frozen at branch creation): play-log, narrator
  system prompt, world-stack slice
- HTML render flag as a follow-on once raw output looks promising

**Out of scope**
- Archivist prompts (narrator only this morning)
- Quality scoring or evaluation rubrics
- Integration back into the main app
- Model curation / shortlists — the user drives model selection by loading and
  unloading in LM Studio

## Branch & Layout

Orphan branch `lab/local-models`, worktree at
`.claude/worktrees/local-models/`. Mirrors the existing
`worktree-gemini-tts-spike` pattern.

```
.claude/worktrees/local-models/
├── package.json           # minimal: bun-types only, no app deps
├── tsconfig.json
├── probe.ts               # the one-shot CLI
├── fixtures/
│   ├── play-log.jsonl     # frozen copy of main's play-log at branch creation
│   ├── narrator-system.txt # frozen copy of the narrator system prompt
│   └── world-stack.json   # frozen copy of world-stack
├── results/               # gitignored
│   └── .gitkeep
└── README.md
```

The `fixtures/` files are **copies, not symlinks** — the lab must stand alone
even after the main branch evolves. They get re-snapshotted manually if needed.

## Probe Behavior

### Invocation

```sh
bun probe.ts <turn-index>           # raw dump
bun probe.ts <turn-index> --render  # follow-on; emits HTML
```

### Steps (raw mode)

1. Read `fixtures/play-log.jsonl`, find the entry with `turn === <turn-index>`.
2. Reconstruct the narrator prompt from fixtures:
   - System message: contents of `fixtures/narrator-system.txt`
   - Canonical state: the entries from `fixtures/world-stack.json` for the
     turn's position and its four cardinal neighbors (matches what the real
     narrator sees per the geography-drift fix)
   - User message: the `input` field from the play-log entry
3. `GET http://localhost:1234/v1/models` to discover the loaded model id.
   Endpoint is env-overridable via `LM_STUDIO_URL`.
4. `POST .../v1/chat/completions` with the constructed messages. Non-streaming
   for first pass (simpler to dump raw). Temperature and max_tokens hardcoded
   to match the app's narrator defaults; documented in `README.md`.
5. Write the response to:
   - **stdout** — stringified (`JSON.stringify(response, null, 2)`), so
     `<think>` tags, escapes, and role wrappers are all visible
   - **`results/<ISO-timestamp>--<model-id>--turn-<n>.txt`** — same content,
     for later scrolling

### Steps (render mode)

Run after raw mode against the same turn:

1. Glob `results/*--turn-<n>.txt`, sort by filename (timestamp prefix sorts
   correctly), read the newest.
2. Strip `<think>...</think>`, `<thinking>...</thinking>`, and
   `<reasoning>...</reasoning>` blocks (case-insensitive, non-greedy).
3. If the stripped result is empty, fall back to extracting the **last
   paragraph inside** the first thinking block (the "translation matrix"
   case — model put the narrative in the scratchpad).
4. Emit `results/<...>.html` with the cleaned narrative styled loosely like
   the app's turn card (charcoal background, Inter, one accent color).

## Why an Orphan Branch

A regular feature branch would carry `src/`, `node_modules/`, the world-stack,
and the play-log into the lab. The lab doesn't need any of that — and dragging
the app in invites accidental imports that break isolation. An orphan branch
starts at commit-zero with nothing tracked, which makes the lab's contract
("nothing here depends on the main app") visible from `git log` alone.

## Success Criterion

Cycle time for the workflow below is well under a minute:

1. User loads a model in LM Studio
2. `bun probe.ts 42`
3. User reads raw dump
4. User decides: try a different model, or move to `--render`

## Open Questions

None blocking. Render mode's exact CSS is left to taste — it doesn't affect
the model evaluation, just makes the cleaned output prettier.

## Non-Goals (Reiterated for Future-Me)

- This is **not** a benchmark. No metrics, no leaderboards.
- This is **not** the start of multi-model support in the app. If a model
  wins here, integration is a separate spec.
- This is **not** a thinking-tag library. The strip/extract logic is the
  minimum needed to see if the prose is salvageable; it can be quick and
  fragile.
