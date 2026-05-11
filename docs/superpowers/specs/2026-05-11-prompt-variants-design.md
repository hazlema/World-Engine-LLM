# Prompt-Variant Workflow for Probe Lab — Design

**Date:** 2026-05-11
**Branch:** `lab/local-models` (orphan)
**Worktree:** `.claude/worktrees/local-models/`

## Purpose

Tune system prompts against the existing single-turn probe so a smaller model
(e.g. `mistralai/ministral-3-3b`) can be coaxed into following the narrator
rules without regressing the larger baseline (`google/gemma-3-12b`). The bake-off
already established ministral as fast and creative but rule-breaking; tightening
the prompt with a few well-placed examples is the cheapest path to making it
viable.

The design optimizes for the **iteration loop**: edit prompt → run probe →
read result → tweak. File-based, terminal-driven, results auto-labeled.

## Scope

**In scope**
- Add `--prompt <name>` flag to `probe.ts`
- New `fixtures/prompts/` directory with `default.txt` as the canonical
  starting point for variants
- Variant name baked into result filename and dump JSON
- One unit test for prompt-fixture resolution
- README updates for the lab

**Out of scope**
- `--prompt all` sweep mode (deferred — add only if iteration gets painful)
- Web UI for editing/running prompts (deferred — same reason)
- Quality scoring or auto-diffing
- Modifying the main app's `NARRATOR_SYSTEM` based on lab findings — that's
  a separate downstream task

## File layout

```
.claude/worktrees/local-models/
├── fixtures/
│   ├── narrator-system.txt          # unchanged — original snapshot
│   ├── prompts/
│   │   ├── default.txt              # NEW — verbatim copy of narrator-system.txt
│   │   └── (user-created variants)  # e.g. ministral-shots.txt
│   ├── play-log.jsonl
│   └── world-stack.json
├── probe.ts                          # modified — adds --prompt handling
├── probe.test.ts                     # modified — adds resolution test
├── results/                          # filename format changes
└── README.md                         # modified — documents new flag
```

Why `default.txt` as a copy rather than a symlink to `narrator-system.txt`:
the lab is throwaway and self-contained. Symlinks add surprise; a flat copy
is the obvious thing to find when looking for "the starting prompt." If
`narrator-system.txt` ever gets re-snapshotted from main, the user can
re-copy intentionally.

## CLI behavior

### Invocation

```sh
bun probe.ts <turn>                     # uses fixtures/narrator-system.txt
bun probe.ts <turn> --prompt <name>     # uses fixtures/prompts/<name>.txt
```

Existing flags (`--render` from the deferred Task 9) are unaffected.

### Resolution rules

- **No `--prompt`:** load `fixtures/narrator-system.txt`. Variant tag in
  output filename and dump JSON is `default` (so even no-flag runs are
  diffable against intentional variants).
- **`--prompt <name>`:** load `fixtures/prompts/<name>.txt`. If missing,
  exit 1 with: `"No prompt fixture at fixtures/prompts/<name>.txt — list available with: ls fixtures/prompts"`
- **`--prompt default`:** explicitly addresses `fixtures/prompts/default.txt`.
  Treated like any other named variant; its contents start as a copy of
  `narrator-system.txt` but diverge if the user edits it.

### Output changes

Result filename gains the variant slug:

```
results/<ISO-stamp>--<modelId>--<variant>--turn-<n>.txt
```

Examples:
- `2026-05-11T17-25-59Z--google_gemma-4-e2b--default--turn-1.txt`
- `2026-05-11T20-10-00Z--mistralai_ministral-3-3b--ministral-shots--turn-1.txt`

Dump JSON gains a top-level `promptVariant` field next to the existing
`turn`, `position`, `input`, `modelId`, `request`, `response`.

Old result files (created before this change, lacking the variant segment)
coexist fine — globbing the new format is just `*--<variant>--turn-<n>.txt`.

## Code changes (high level)

`probe.ts`:
- Update `loadSystemPrompt()` to take an optional `variant?: string` argument.
  - No arg → reads `fixtures/narrator-system.txt` (unchanged path).
  - With arg → reads `fixtures/prompts/<variant>.txt`.
  - Throws a descriptive error when the variant file is missing.
- Update `main()` to parse `--prompt <name>` from `process.argv` alongside
  existing arg handling.
- Pass the resolved variant name to the dump JSON (`promptVariant`) and to
  the result filename builder.

`probe.test.ts`:
- One new test: `loadSystemPrompt("default")` returns the same content as
  `loadSystemPrompt()` after Task 1 copies `narrator-system.txt → prompts/default.txt`.
- One new test: `loadSystemPrompt("does-not-exist")` rejects with an error
  whose message contains `"fixtures/prompts/does-not-exist.txt"`.

`README.md` (in the lab worktree):
- Replace the `## Run a probe` section to document `--prompt`.
- Add a `## Iterating on prompts` section with the workflow (cp, edit, run,
  compare).

## The iteration loop (success criterion)

The lab is successful if this is fast enough to run 10+ tweaks per hour
without friction:

1. `cp fixtures/prompts/default.txt fixtures/prompts/ministral-shots.txt`
2. Edit `fixtures/prompts/ministral-shots.txt` in any editor
3. Load ministral in LM Studio (manual)
4. `bun probe.ts 1 --prompt ministral-shots`
5. Read the dump. Tweak the file. `↑ Enter` to rerun.
6. When the prompt looks dialed in, swap to gemma in LM Studio, run the
   same `--prompt ministral-shots` command. Confirm 12B output didn't
   regress.
7. Diff variants when needed: `diff <(jq -r .response.choices[0].message.content results/*--default--turn-1.txt | head -1) <(jq -r .response.choices[0].message.content results/*--ministral-shots--turn-1.txt | head -1)`

The dual-model check in step 6 is the "satisfy both interpretations" test:
a prompt that earns ministral compliance without losing gemma's range.

## Non-goals (reiterated)

- No multi-variant sweep mode. If you want to compare three prompts on one
  model, run the probe three times. The labeled result files make grep/diff
  trivial.
- No automated "is this prompt better?" scoring. Eyeballing is the right
  resolution for prose evaluation — the same reason the original probe was
  raw-dump-first.
- No modification to the main app yet. Successful variants are interesting
  data; rolling them into `src/engine.ts` is a separate downstream decision.
