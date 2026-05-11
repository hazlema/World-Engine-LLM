# Prompt-Variant Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--prompt <name>` flag to the probe lab so the user can edit prompt files in `fixtures/prompts/` and rapidly iterate on system-prompt variants without changing the snapshotted `narrator-system.txt`. Results are labeled with the variant for later diffing.

**Architecture:** Self-contained changes inside the existing orphan-branch worktree at `.claude/worktrees/local-models/`. Three substantive code touches — fixture folder setup, `loadSystemPrompt` extension, CLI flag wiring — plus a README update. All changes additive; no-flag invocation preserves current behavior exactly.

**Tech Stack:** Bun, TypeScript. Same constraints as the existing probe — Bun-native APIs only (Bun.file / Bun.write), `bun:test` for tests, no new dependencies.

**Working convention:** Test-after for the pure function change (Task 2). Arg-parsing smoke tests for Task 3.

**Working directory for ALL tasks:** `/home/frosty/Dev/ai/adventure/.claude/worktrees/local-models/`

---

## Task 1: Create `fixtures/prompts/` with `default.txt`

**Files:**
- Create: `fixtures/prompts/default.txt` (verbatim copy of `fixtures/narrator-system.txt`)

- [ ] **Step 1: Make the prompts directory and copy the current snapshot**

```bash
mkdir -p fixtures/prompts
cp fixtures/narrator-system.txt fixtures/prompts/default.txt
```

- [ ] **Step 2: Verify the copy is byte-identical**

```bash
diff fixtures/narrator-system.txt fixtures/prompts/default.txt && echo "identical"
```

Expected: `identical`.

- [ ] **Step 3: Commit**

```bash
git add fixtures/prompts/default.txt
git commit -m "chore: seed fixtures/prompts/default.txt for variant-iteration workflow"
```

Expected: a single new tracked file in the commit; no other changes.

---

## Task 2: Extend `loadSystemPrompt()` to accept an optional variant

**Files:**
- Modify: `probe.ts` (replace the existing `loadSystemPrompt` function)
- Modify: `probe.test.ts` (add two new tests)

The existing `loadSystemPrompt` currently reads `fixtures/narrator-system.txt` with no arg. After this task, calling it with no arg keeps that behavior; calling with a variant name reads `fixtures/prompts/<variant>.txt`.

- [ ] **Step 1: Replace `loadSystemPrompt` in `probe.ts`**

Locate the current function (block starts with `export async function loadSystemPrompt()` and is two lines long). Replace those two lines with:

```ts
export async function loadSystemPrompt(variant?: string): Promise<string> {
  if (variant === undefined) {
    return Bun.file(new URL("narrator-system.txt", FIXTURES_PATH)).text();
  }
  const file = Bun.file(new URL(`prompts/${variant}.txt`, FIXTURES_PATH));
  if (!(await file.exists())) {
    throw new Error(
      `No prompt fixture at fixtures/prompts/${variant}.txt — list available with: ls fixtures/prompts`
    );
  }
  return file.text();
}
```

- [ ] **Step 2: Add two new tests to `probe.test.ts`**

Append to the end of `probe.test.ts`:

```ts
test("loadSystemPrompt('default') returns the same content as no-arg call", async () => {
  const explicit = await loadSystemPrompt("default");
  const implicit = await loadSystemPrompt();
  expect(explicit).toBe(implicit);
  expect(explicit.length).toBeGreaterThan(1000);
});

test("loadSystemPrompt throws a helpful error for a missing variant", async () => {
  await expect(loadSystemPrompt("does-not-exist")).rejects.toThrow(
    /fixtures\/prompts\/does-not-exist\.txt/
  );
});
```

These rely on Task 1 having created `fixtures/prompts/default.txt` as a copy of `narrator-system.txt`.

- [ ] **Step 3: Run the tests**

```bash
bun test probe.test.ts
```

Expected: 8 pass, 0 fail (6 existing + 2 new).

- [ ] **Step 4: Type-check**

```bash
bunx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add probe.ts probe.test.ts
git commit -m "feat: loadSystemPrompt accepts optional variant from fixtures/prompts/"
```

---

## Task 3: Wire `--prompt` flag through `main()`, dump JSON, and result filename

**Files:**
- Modify: `probe.ts` (replace the existing `main` function)

After this task, `bun probe.ts <turn>` works as before; `bun probe.ts <turn> --prompt <name>` reads `fixtures/prompts/<name>.txt` and tags the result with `<name>`.

- [ ] **Step 1: Replace the `main()` function in `probe.ts`**

Locate the current `async function main(): Promise<void>` block and the `if (import.meta.main)` block that follows it. Replace the WHOLE `main` function body (keep the `if (import.meta.main)` runner unchanged) with:

```ts
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const promptIdx = args.indexOf("--prompt");
  let variant: string | undefined;
  if (promptIdx !== -1) {
    variant = args[promptIdx + 1];
    if (!variant || variant.startsWith("--")) {
      console.error("--prompt requires a variant name (e.g. --prompt default)");
      process.exit(2);
    }
  }
  const turnArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--prompt");
  if (!turnArg) {
    console.error("usage: bun probe.ts <turn-index> [--prompt <name>]");
    process.exit(2);
  }
  const turnIndex = Number.parseInt(turnArg, 10);
  if (!Number.isInteger(turnIndex)) {
    console.error(`invalid turn index: ${turnArg}`);
    process.exit(2);
  }

  const variantTag = variant ?? "default";
  const [entry, systemPrompt, worldStack] = await Promise.all([
    loadTurn(turnIndex),
    loadSystemPrompt(variant),
    loadWorldStack(),
  ]);
  const messages = buildMessages({
    systemPrompt,
    worldStack,
    position: entry.position,
    input: entry.input,
  });
  const result = await callLMStudio(messages);

  const dump = JSON.stringify(
    {
      turn: entry.turn,
      position: entry.position,
      input: entry.input,
      promptVariant: variantTag,
      ...result,
    },
    null,
    2
  );
  console.log(dump);

  const safeModelId = result.modelId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const safeVariant = variantTag.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = new URL(
    `./results/${stamp}--${safeModelId}--${safeVariant}--turn-${entry.turn}.txt`,
    import.meta.url
  );
  await Bun.write(outPath, dump);
  console.error(`[probe] wrote ${outPath.pathname}`);
}
```

Key behavioral notes for the reader:
- The arg parser distinguishes "the turn-index positional" from "the value after `--prompt`" by checking that the previous arg isn't `--prompt`.
- `variant` (the raw user input) is what's passed to `loadSystemPrompt` — undefined when no flag, otherwise the user's string.
- `variantTag` (the display label) is always defined — `"default"` when no flag, otherwise the variant name. This is what lands in `promptVariant` and the filename.
- The filename now has FOUR segments separated by `--` instead of three: `<stamp>--<model>--<variant>--turn-<n>.txt`.

- [ ] **Step 2: Smoke-test arg parsing (no LM Studio needed)**

```bash
set +e
bun probe.ts; echo "exit=$?"
bun probe.ts abc; echo "exit=$?"
bun probe.ts --prompt; echo "exit=$?"
bun probe.ts 1 --prompt; echo "exit=$?"
```

Expected outputs:
- `bun probe.ts` → `usage: bun probe.ts <turn-index> [--prompt <name>]`, exit 2
- `bun probe.ts abc` → `invalid turn index: abc`, exit 2
- `bun probe.ts --prompt` → `--prompt requires a variant name (e.g. --prompt default)`, exit 2
- `bun probe.ts 1 --prompt` → `--prompt requires a variant name (e.g. --prompt default)`, exit 2

- [ ] **Step 3: Type-check + existing tests still pass**

```bash
bunx tsc --noEmit
bun test probe.test.ts
```

Expected: tsc clean; 8 pass / 0 fail.

- [ ] **Step 4: Smoke-test happy path (requires LM Studio running with any model loaded)**

This step is **optional for an automated executor** — if LM Studio isn't running, skip it and report the omission. The human user can run it manually.

```bash
bun probe.ts 1 --prompt does-not-exist 2>&1 | tail -3
```

Expected: `[probe] error: Error: No prompt fixture at fixtures/prompts/does-not-exist.txt — list available with: ls fixtures/prompts`, exit 1.

```bash
bun probe.ts 1 --prompt default 2>&1 | tail -1
```

Expected (if LM Studio running): `[probe] wrote .../results/<stamp>--<modelId>--default--turn-1.txt`. The new file's name has the `--default--` segment.

- [ ] **Step 5: Commit**

```bash
git add probe.ts
git commit -m "feat: probe accepts --prompt <name> and labels output with variant"
```

---

## Task 4: Update the lab README

**Files:**
- Modify: `README.md` (the lab's README inside the worktree, NOT the main app's README)

- [ ] **Step 1: Replace the existing `## Run a probe` section**

Open `README.md`. Find the section starting with `## Run a probe` and ending just before `## Iteration loop`. Replace the whole section (keep the `## Iteration loop` heading and what follows intact for now — Step 2 reworks that part) with:

```markdown
## Run a probe

```sh
bun probe.ts 1                          # default prompt, replays turn 1
bun probe.ts 42                         # default prompt, turn 42
bun probe.ts 1 --prompt ministral-shots # uses fixtures/prompts/ministral-shots.txt
```

Override the LM Studio URL with `LM_STUDIO_URL=http://host:port bun probe.ts 1`.

Result files land in `results/` with the format:

```
<ISO-timestamp>--<model-id>--<variant>--turn-<n>.txt
```

`<variant>` is `default` for no-flag runs, or whatever name you passed to `--prompt`.
```

(Note: the inner triple-backtick blocks need to live inside the file. If your editor mangles fences, write them directly with the Write tool.)

- [ ] **Step 2: Replace the existing `## Iteration loop` section**

Right after the section you just wrote, find `## Iteration loop`. Replace its content (keep the heading) with:

```markdown
## Iteration loop

### Swapping models

1. Load a model in LM Studio.
2. `bun probe.ts <turn>` and read the raw dump.
3. Note whether the prose lives in the post-response or inside `<think>...</think>`.
4. Unload, load the next model, repeat.

### Iterating on prompts

The probe reads its system prompt from `fixtures/narrator-system.txt` by
default (a snapshot of `NARRATOR_SYSTEM` from the main app). To experiment
with variants without touching that snapshot:

1. **Branch off the default:**
   ```sh
   cp fixtures/prompts/default.txt fixtures/prompts/ministral-shots.txt
   ```
2. **Edit the new file** in any editor.
3. **Run the probe with the variant:**
   ```sh
   bun probe.ts 1 --prompt ministral-shots
   ```
4. **Read the dump, tweak the prompt file, rerun.** The labeled result
   files (`...--<variant>--turn-<n>.txt`) make it easy to compare runs
   across variants later.
5. **Test the variant on a second model.** Swap the loaded model in
   LM Studio, run the same `--prompt ministral-shots` command. A good
   variant works on both small and large models — that's the bar before
   rolling anything into the main app.

All raw dumps land in `results/` for later comparison — they're gitignored.
```

- [ ] **Step 3: Verify the README still renders sensibly**

```bash
head -80 README.md
```

Expected: the new `## Run a probe` and `## Iteration loop` sections are present and well-formed; the rest of the file (Prerequisites, Setup, Fixtures, Defaults, Render mode) is untouched.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document --prompt flag and prompt-variant iteration loop"
```

---

## Done

After Task 4, the workflow described in the spec is live:

```sh
cp fixtures/prompts/default.txt fixtures/prompts/v1.txt
vim fixtures/prompts/v1.txt
bun probe.ts 1 --prompt v1
# read, tweak, rerun
```

Result files are labeled and grep-able. The `narrator-system.txt` snapshot is untouched. No GUI, no extra dependencies. If the file-based loop gets painful (lots of small edits, hard to compare), the deferred GUI is the obvious follow-on — but cross that bridge only if it actually hurts.
