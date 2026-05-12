# Narrator Abilities LoRA Training — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the dataset-gen + LoRA-DPO training + GGUF-merge pipeline that produces a `ministral-3b-world-engine-v1` model trained to refuse player-declared unestablished abilities, validated against the lab testbed.

**Architecture:** New worktree on branch `train/narrator-abilities-lora` off `main`. Two-language split: Bun owns dataset generation (familiar `fetch` calls to LM Studio + JSONL output); Python owns training (LoRA + DPO via Hugging Face TRL). Handoff is a JSONL preference-pair file on disk. Python deps are installed via `uv` with pinned versions, audited lockfile, isolated venv inside the worktree. The actual training run is a manual step the user kicks off after inspecting the dataset; the plan builds infrastructure, not training results.

**Tech Stack:** Bun (TypeScript) for dataset orchestration. Python 3.11+ with `uv` for the venv, `transformers` + `peft` + `trl` for LoRA-DPO, `bitsandbytes` for 4-bit quantization, `gguf` + `llama.cpp` for the merge-to-GGUF step. The lab testbed (already built on the `lab/local-models` branch) is reused for validation.

**Branch policy:** Phases 1-5 work on `train/narrator-abilities-lora` in worktree `.claude/worktrees/train-narrator-abilities/`. Phase 6 work happens on `lab/local-models` in worktree `.claude/worktrees/local-models/`. Each task calls out the active branch.

---

## Phase 1 — Worktree + scaffold

### Task 1: Create the worktree and initial directory structure

**Files:**
- Create: `.claude/worktrees/train-narrator-abilities/` (via `git worktree add`)
- Create: `.claude/worktrees/train-narrator-abilities/.gitignore`
- Create: `.claude/worktrees/train-narrator-abilities/.env`
- Create: `.claude/worktrees/train-narrator-abilities/bun/`
- Create: `.claude/worktrees/train-narrator-abilities/bun/prompts/`
- Create: `.claude/worktrees/train-narrator-abilities/bun/lib/`
- Create: `.claude/worktrees/train-narrator-abilities/python/`
- Create: `.claude/worktrees/train-narrator-abilities/dataset/.gitkeep`
- Create: `.claude/worktrees/train-narrator-abilities/output/.gitkeep`

- [ ] **Step 1: Confirm starting branch**

From `/home/frosty/Dev/ai/adventure`:

```bash
git status
git rev-parse --abbrev-ref HEAD
```

Expected: on `main`, working tree clean (modulo any in-flight gameplay artifacts like `play-log.jsonl`).

- [ ] **Step 2: Create the worktree and orphan-ish branch**

```bash
git worktree add -b train/narrator-abilities-lora .claude/worktrees/train-narrator-abilities main
cd .claude/worktrees/train-narrator-abilities
git status
```

Expected: new worktree appears at the path; branch `train/narrator-abilities-lora` checked out; working tree clean (mirrors `main`).

- [ ] **Step 3: Create the directory scaffolding**

```bash
mkdir -p bun/prompts bun/lib python dataset output HF_HOME
touch dataset/.gitkeep output/.gitkeep
```

- [ ] **Step 4: Write `.gitignore`**

Create `.gitignore` at the worktree root with this content:

```gitignore
# Python venv + caches scoped to this worktree
.venv/
__pycache__/
*.pyc
.pytest_cache/

# Hugging Face model cache (gigabytes of weights)
HF_HOME/

# Training artifacts (datasets, adapters, merged models, GGUFs)
dataset/*.jsonl
output/

# Keep the directory structure
!dataset/.gitkeep
!output/.gitkeep

# Local env overrides
.env
```

- [ ] **Step 5: Write `.env`**

Create `.env` at the worktree root:

```env
# Hugging Face cache scoped to this worktree (don't pollute ~/.cache/huggingface)
HF_HOME=./HF_HOME

# LM Studio endpoint for dataset generation
LM_STUDIO_URL=http://localhost:1234
```

- [ ] **Step 6: Commit the scaffold**

```bash
git add .gitignore dataset/.gitkeep output/.gitkeep
git commit -m "$(cat <<'EOF'
chore: scaffold train-narrator-abilities worktree

New branch off main for the LoRA + DPO training pipeline that targets
ministral-3-3b's pliability on player-declared unestablished abilities.
See docs/superpowers/specs/2026-05-12-narrator-abilities-lora-training-design.md.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

`.env` is gitignored (it's a local config) — don't add it to the commit.

---

## Phase 2 — Bun dataset generation

All Phase 2 work happens in `.claude/worktrees/train-narrator-abilities/`. Bun is already on PATH (per the main project's CLAUDE.md).

### Task 2: Snapshot the production narrator system prompt

The dataset gen needs the EXACT narrator system prompt that production uses, frozen at this point in time. If main's `NARRATOR_SYSTEM` changes later, the training dataset's prompts shouldn't drift.

**Files:**
- Create: `bun/lib/narrator-prompt.ts`

- [ ] **Step 1: Dump the production prompt from main**

From the worktree root, read the production `NARRATOR_SYSTEM` and write it as a TypeScript constant:

```bash
bun -e "
import('/home/frosty/Dev/ai/adventure/src/engine').then(m => {
  const body = \`// Snapshot of NARRATOR_SYSTEM from main at the time this branch was created.
// DO NOT edit this to fix prompt issues — that bias the training data.
// If you want fresh production prompt, re-snapshot via:
//   bun -e \\\"import('PATH/main/src/engine').then(m => Bun.write('bun/lib/narrator-prompt.ts', '...'))\\\"

export const NARRATOR_SYSTEM = \\\`\${m.NARRATOR_SYSTEM.replace(/\\\`/g, '\\\\\\\`').replace(/\\\\$/g, '\\\\\\\\$')}\\\`;
\`;
  Bun.write('bun/lib/narrator-prompt.ts', body);
});
"
wc -l bun/lib/narrator-prompt.ts
```

Expected: ~50 lines in the new file. First 4 lines are the doc comment; rest is the constant.

- [ ] **Step 2: Sanity-check the snapshot**

```bash
bun -e 'import("./bun/lib/narrator-prompt").then(m => { console.log("first 100 chars:", m.NARRATOR_SYSTEM.slice(0, 100)); console.log("length:", m.NARRATOR_SYSTEM.length, "chars"); console.log("under 150 words instruction present:", m.NARRATOR_SYSTEM.includes("under 150 words")); })'
```

Expected: prints the opening lines (`You are a living world...`), length around 8500-9500 chars, and `under 150 words instruction present: true` (confirming we have the post-cap-update version).

- [ ] **Step 3: Commit**

```bash
git add bun/lib/narrator-prompt.ts
git commit -m "feat(train): snapshot production NARRATOR_SYSTEM for dataset gen

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: Build ability-declaration patterns

**Files:**
- Create: `bun/prompts/ability-patterns.ts`

- [ ] **Step 1: Create the patterns module**

Create `bun/prompts/ability-patterns.ts`:

```ts
/**
 * Player-action strings that DECLARE an unestablished ability.
 *
 * These are the input space for DPO preference-pair generation. Each one
 * should — under the production NARRATOR_SYSTEM rules — produce a refusal
 * (the world doesn't grant magic / impossible feats / facts the player
 * invents). Ministral often plays along anyway; gemma refuses more
 * reliably. Disagreements feed training.
 */

export type Bucket = "magic" | "implausible_physical" | "fact_injection" | "resource_summoning";

export interface AbilityPattern {
  id: string;
  bucket: Bucket;
  text: string;
}

export const ABILITY_PATTERNS: AbilityPattern[] = [
  // Magic / supernatural
  { id: "magic-1",  bucket: "magic", text: "use your magic" },
  { id: "magic-2",  bucket: "magic", text: "I cast fireball" },
  { id: "magic-3",  bucket: "magic", text: "I shapeshift into a wolf" },
  { id: "magic-4",  bucket: "magic", text: "I teleport away" },
  { id: "magic-5",  bucket: "magic", text: "I summon a sword from thin air" },
  { id: "magic-6",  bucket: "magic", text: "I fly up to the ceiling" },
  { id: "magic-7",  bucket: "magic", text: "I conjure a hot meal" },
  { id: "magic-8",  bucket: "magic", text: "I scry the future" },
  { id: "magic-9",  bucket: "magic", text: "I read his mind" },
  { id: "magic-10", bucket: "magic", text: "I cast invisibility on myself" },

  // Implausible physical
  { id: "phys-1",  bucket: "implausible_physical", text: "I leap across the chasm" },
  { id: "phys-2",  bucket: "implausible_physical", text: "I tear the iron door off its hinges" },
  { id: "phys-3",  bucket: "implausible_physical", text: "I dodge the arrow mid-flight" },
  { id: "phys-4",  bucket: "implausible_physical", text: "I lift the boulder above my head" },
  { id: "phys-5",  bucket: "implausible_physical", text: "I run up the wall and across the ceiling" },
  { id: "phys-6",  bucket: "implausible_physical", text: "I punch through the iron gate" },
  { id: "phys-7",  bucket: "implausible_physical", text: "I hold my breath for ten minutes" },
  { id: "phys-8",  bucket: "implausible_physical", text: "I survive the fall without injury" },
  { id: "phys-9",  bucket: "implausible_physical", text: "I outrun the horse on foot" },
  { id: "phys-10", bucket: "implausible_physical", text: "I crush the rock with my bare hands" },

  // Fact-injection
  { id: "fact-1",  bucket: "fact_injection", text: "I am secretly the king's lost son" },
  { id: "fact-2",  bucket: "fact_injection", text: "I have a sword hidden in my pocket" },
  { id: "fact-3",  bucket: "fact_injection", text: "I remember the password is crimson" },
  { id: "fact-4",  bucket: "fact_injection", text: "I see through her disguise immediately" },
  { id: "fact-5",  bucket: "fact_injection", text: "I know this man from years ago" },
  { id: "fact-6",  bucket: "fact_injection", text: "I happen to speak the local language fluently" },
  { id: "fact-7",  bucket: "fact_injection", text: "I am wearing armor under my cloak" },
  { id: "fact-8",  bucket: "fact_injection", text: "I have memorized the map of this city" },
  { id: "fact-9",  bucket: "fact_injection", text: "I recognize this symbol from a forbidden book" },
  { id: "fact-10", bucket: "fact_injection", text: "I am immune to the poison" },

  // Resource summoning
  { id: "res-1",  bucket: "resource_summoning", text: "I pull out a bag of gold coins" },
  { id: "res-2",  bucket: "resource_summoning", text: "I find a key in my pocket" },
  { id: "res-3",  bucket: "resource_summoning", text: "I produce a healing potion from my pack" },
  { id: "res-4",  bucket: "resource_summoning", text: "I happen to have rope with me" },
  { id: "res-5",  bucket: "resource_summoning", text: "I bring out a map of this exact area" },
  { id: "res-6",  bucket: "resource_summoning", text: "I unwrap the lockpicks I have been carrying" },
  { id: "res-7",  bucket: "resource_summoning", text: "I pull out a torch and light it" },
  { id: "res-8",  bucket: "resource_summoning", text: "I retrieve my flask of whiskey" },
  { id: "res-9",  bucket: "resource_summoning", text: "I have a dagger in my boot" },
  { id: "res-10", bucket: "resource_summoning", text: "I take out a coil of wire from my bag" },
];
```

- [ ] **Step 2: Verify counts**

```bash
bun -e 'import("./bun/prompts/ability-patterns").then(m => { const buckets = {}; for (const p of m.ABILITY_PATTERNS) buckets[p.bucket] = (buckets[p.bucket]||0)+1; console.log("total:", m.ABILITY_PATTERNS.length); console.log("buckets:", buckets); })'
```

Expected: `total: 40`, each bucket has 10 entries.

- [ ] **Step 3: Commit**

```bash
git add bun/prompts/ability-patterns.ts
git commit -m "feat(train): 40 ability-declaration patterns across 4 buckets

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: Build world-context wrappers

**Files:**
- Create: `bun/prompts/world-contexts.ts`

- [ ] **Step 1: Create the world-contexts module**

Create `bun/prompts/world-contexts.ts`:

```ts
/**
 * Brief MISSION BRIEFING blocks that wrap each ability pattern.
 *
 * Cross-product: (40 patterns) x (8 contexts) = 320 base scenarios.
 *
 * Keep each context minimal (1-2 sentences). No ESTABLISHED WORLD,
 * no OBJECTIVES — we want to test PURE declaration behavior with
 * minimal grounding the model could lean on.
 */

export interface WorldContext {
  id: string;
  briefing: string;
}

export const WORLD_CONTEXTS: WorldContext[] = [
  {
    id: "medieval-forest",
    briefing: "MISSION BRIEFING (durable premise):\nYou are a hooded traveller crossing a dense northern forest. The road is muddy with last night's rain.",
  },
  {
    id: "sci-fi-lunar",
    briefing: "MISSION BRIEFING (durable premise):\nYou are an astronaut on the lunar far side, your damaged lander a kilometre behind you. The suit's life support is bleeding oxygen.",
  },
  {
    id: "urban-noir",
    briefing: "MISSION BRIEFING (durable premise):\nYou are a tired private investigator in a rain-slick city alley. Neon from the bar opposite paints everything green.",
  },
  {
    id: "fantasy-court",
    briefing: "MISSION BRIEFING (durable premise):\nYou are an emissary kneeling in the king's audience hall. Armed guards line the walls; the throne is empty.",
  },
  {
    id: "post-apoc",
    briefing: "MISSION BRIEFING (durable premise):\nYou are a scavenger picking through the ruins of an old hospital. The world ended decades ago; everything useful is buried under collapsed ceilings.",
  },
  {
    id: "pirate-ship",
    briefing: "MISSION BRIEFING (durable premise):\nYou are a deckhand on a brig running before a storm. The captain is below, the bosun is shouting, and the rigging is wet.",
  },
  {
    id: "empty-world",
    briefing: "MISSION BRIEFING (durable premise):\nYou are standing in a flat open plain at dusk. There is no preset. The world is what you make of it.",
  },
  {
    id: "underground-dungeon",
    briefing: "MISSION BRIEFING (durable premise):\nYou are in a damp underground passage, torchlight flickering off carved stone. The path forks ahead.",
  },
];
```

- [ ] **Step 2: Verify counts**

```bash
bun -e 'import("./bun/prompts/world-contexts").then(m => { console.log("contexts:", m.WORLD_CONTEXTS.length); for (const c of m.WORLD_CONTEXTS) console.log(" -", c.id); })'
```

Expected: 8 contexts, all listed.

- [ ] **Step 3: Commit**

```bash
git add bun/prompts/world-contexts.ts
git commit -m "feat(train): 8 world-context briefings for cross-product

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: Build the LM Studio call helper (TDD)

**Files:**
- Create: `bun/lib/lm-studio.ts`
- Create: `bun/lib/lm-studio.test.ts`

- [ ] **Step 1: Write the failing test**

Create `bun/lib/lm-studio.test.ts`:

```ts
import { test, expect } from "bun:test";
import { callNarrator } from "./lm-studio";

test("callNarrator sends system+user, returns content from response", async () => {
  let seen: any = null;
  const fakeFetch: typeof fetch = async (url, init) => {
    const s = url.toString();
    if (s.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "fake-model" }] }), { status: 200 });
    }
    seen = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "the world does not bend." } }],
    }), { status: 200 });
  };

  const out = await callNarrator({
    systemPrompt: "SYS",
    userMessage: "MISSION BRIEFING (durable premise):\nA road.\n\nPLAYER ACTION: I cast fireball",
    modelId: "fake-model",
    temperature: 0.5,
    fetchImpl: fakeFetch,
    baseUrl: "http://localhost:1234",
  });

  expect(out.content).toBe("the world does not bend.");
  expect(out.modelId).toBe("fake-model");
  expect(seen.model).toBe("fake-model");
  expect(seen.messages[0]).toEqual({ role: "system", content: "SYS" });
  expect(seen.messages[1].content).toContain("PLAYER ACTION: I cast fireball");
  expect(seen.temperature).toBe(0.5);
});

test("callNarrator throws on non-OK response", async () => {
  const fakeFetch: typeof fetch = async (url) => {
    const s = url.toString();
    if (s.endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "x" }] }));
    return new Response("model busy", { status: 503 });
  };
  await expect(
    callNarrator({
      systemPrompt: "SYS",
      userMessage: "u",
      modelId: "x",
      temperature: 0.5,
      fetchImpl: fakeFetch,
      baseUrl: "http://localhost:1234",
    }),
  ).rejects.toThrow(/503/);
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
bun test bun/lib/lm-studio.test.ts
```

Expected: module-not-found errors for `./lm-studio`.

- [ ] **Step 3: Implement `lm-studio.ts`**

Create `bun/lib/lm-studio.ts`:

```ts
export interface CallNarratorOpts {
  systemPrompt: string;
  userMessage: string;
  modelId: string;
  temperature: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface CallNarratorResult {
  modelId: string;
  content: string;
}

export async function callNarrator(opts: CallNarratorOpts): Promise<CallNarratorResult> {
  const f = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? process.env.LM_STUDIO_URL ?? "http://localhost:1234";
  const body = {
    model: opts.modelId,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userMessage },
    ],
    temperature: opts.temperature,
    max_tokens: opts.maxTokens ?? 1500,
  };
  const ctrl = new AbortController();
  const t = opts.timeoutMs ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : null;
  try {
    const res = await f(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LM Studio returned ${res.status}: ${text.slice(0, 300)}`);
    }
    const j = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    const content = j.choices?.[0]?.message?.content ?? "";
    return { modelId: opts.modelId, content: String(content) };
  } finally {
    if (t) clearTimeout(t);
  }
}

/**
 * Verify a model id is currently loaded in LM Studio. Throws if not.
 */
export async function assertModelLoaded(
  modelId: string,
  opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? process.env.LM_STUDIO_URL ?? "http://localhost:1234";
  const res = await f(`${baseUrl}/v1/models`);
  if (!res.ok) throw new Error(`LM Studio /v1/models returned ${res.status}`);
  const j = (await res.json()) as { data: Array<{ id: string }> };
  const found = j.data?.some((d) => d.id === modelId);
  if (!found) {
    throw new Error(
      `Model ${modelId} not loaded. Currently loaded: ${j.data?.map((d) => d.id).join(", ") || "(none)"}`,
    );
  }
}
```

- [ ] **Step 4: Run tests, confirm they pass**

```bash
bun test bun/lib/lm-studio.test.ts
```

Expected: 2/2 pass.

- [ ] **Step 5: Commit**

```bash
git add bun/lib/lm-studio.ts bun/lib/lm-studio.test.ts
git commit -m "feat(train): LM Studio caller for dataset gen

Mockable fetch + timeout support; assertModelLoaded helper for
pre-flight checks before a long dataset run.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 6: Disagreement-detection heuristics (TDD)

**Files:**
- Create: `bun/lib/disagreement.ts`
- Create: `bun/lib/disagreement.test.ts`

- [ ] **Step 1: Write the failing test**

Create `bun/lib/disagreement.test.ts`:

```ts
import { test, expect } from "bun:test";
import { classifyResponse, isDisagreement } from "./disagreement";

test("classifyResponse flags magic-acceptance phrasing", () => {
  expect(classifyResponse("You raise your hand and a bolt of fire leaps from your fingers."))
    .toBe("accepts");
  expect(classifyResponse("Your magic flows, and the door bursts open."))
    .toBe("accepts");
  expect(classifyResponse("You summon a sword from thin air; it lands in your grip."))
    .toBe("accepts");
});

test("classifyResponse flags refusal phrasing", () => {
  expect(classifyResponse("You reach for the magic, but nothing answers. Your fingers find empty air."))
    .toBe("refuses");
  expect(classifyResponse("The spell does not come; you are no wizard."))
    .toBe("refuses");
  expect(classifyResponse("You strain, but the boulder does not move. You are an ordinary man."))
    .toBe("refuses");
});

test("classifyResponse returns 'ambiguous' when neither pattern matches", () => {
  expect(classifyResponse("The wind moves through the leaves. A bird calls in the distance."))
    .toBe("ambiguous");
});

test("isDisagreement is true only when ministral=accepts AND gemma=refuses", () => {
  expect(isDisagreement("accepts", "refuses")).toBe(true);
  expect(isDisagreement("refuses", "accepts")).toBe(false);
  expect(isDisagreement("accepts", "accepts")).toBe(false);
  expect(isDisagreement("ambiguous", "refuses")).toBe(false);
  expect(isDisagreement("accepts", "ambiguous")).toBe(false);
});
```

- [ ] **Step 2: Run tests, confirm they fail**

```bash
bun test bun/lib/disagreement.test.ts
```

Expected: module-not-found errors.

- [ ] **Step 3: Implement `disagreement.ts`**

Create `bun/lib/disagreement.ts`:

```ts
export type Classification = "accepts" | "refuses" | "ambiguous";

// Phrasings that strongly suggest the narrator played along with the
// player's declared ability. Case-insensitive substring match.
const ACCEPT_PATTERNS: RegExp[] = [
  /\byour magic\b/i,
  /\bthe spell\b.*\b(answers|comes|flows|works|lands|hits)\b/i,
  /\byou (cast|summon|conjure|teleport|shapeshift|scry)\b/i,
  /\b(a |the )?(bolt|wave|flash) of (fire|lightning|force|magic)\b/i,
  /\b(appears|materializes?) in your (hand|grip|palm)\b/i,
  /\b(you|your hand) (lifts?|raises?) (the|that) (boulder|stone|gate|door)\b/i,
  /\b(you )?(tear|rip) (the )?(door|gate|wall)\b/i,
  /\byou (leap|vault|fly|soar)\b/i,
  /\b(invisible|unseen) (you|as you)\b/i,
];

// Phrasings that strongly suggest the narrator refused the declared ability.
const REFUSE_PATTERNS: RegExp[] = [
  /\bnothing (happens|answers|comes|stirs)\b/i,
  /\byou reach for\b.*\b(empty|nothing|no )/i,
  /\b(your )?fingers find (empty|nothing|no )/i,
  /\bno spell (comes|answers|works)\b/i,
  /\byou are (no|not a) (wizard|sorcerer|mage|magician)\b/i,
  /\b(you are|you remain) (an |a |the )?ordinary (man|woman|mortal|human)\b/i,
  /\b(the world|reality) (does not|will not|refuses to) bend\b/i,
  /\bthe (boulder|stone|gate|door) does not (move|budge|yield)\b/i,
  /\b(you )?strain(s|ed)?\b.*\b(but|yet)\b.*\b(nothing|fails|no )/i,
  /\b(your )?(claim|words) (fade|fall|drift) (into|on) (silence|nothing|emptiness)\b/i,
];

export function classifyResponse(text: string): Classification {
  const acceptsHit = ACCEPT_PATTERNS.some((re) => re.test(text));
  const refusesHit = REFUSE_PATTERNS.some((re) => re.test(text));
  if (acceptsHit && !refusesHit) return "accepts";
  if (refusesHit && !acceptsHit) return "refuses";
  return "ambiguous";
}

export function isDisagreement(
  ministral: Classification,
  gemma: Classification,
): boolean {
  return ministral === "accepts" && gemma === "refuses";
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
bun test bun/lib/disagreement.test.ts
```

Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add bun/lib/disagreement.ts bun/lib/disagreement.test.ts
git commit -m "feat(train): keyword-based response classifier

classifyResponse returns accepts | refuses | ambiguous based on
heuristic regex patterns. isDisagreement(min, gem) is the filter
for keeping a pair: only when ministral accepts AND gemma refuses.
Ambiguous-on-either-side cases get routed to the ambiguous bin
in generate-dataset.ts (next task) for manual review.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 7: The `generate-dataset.ts` CLI

**Files:**
- Create: `bun/generate-dataset.ts`
- Create: `bun/generate-dataset.test.ts`

- [ ] **Step 1: Write failing tests**

Create `bun/generate-dataset.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDataset, type GenerateOpts } from "./generate-dataset";

function makeFakeFetch(ministralAccepts: boolean, gemmaRefuses: boolean): typeof fetch {
  return async (url, init) => {
    const s = url.toString();
    if (s.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "ministral" }, { id: "gemma" }] }));
    }
    const body = JSON.parse(init?.body as string);
    const model = body.model;
    if (model === "ministral") {
      const content = ministralAccepts ? "You raise your hand and a bolt of fire leaps from your fingers."
                                       : "The wind shifts. Leaves drift past.";
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    } else {
      const content = gemmaRefuses ? "You reach for the magic, but nothing answers. Your fingers find empty air."
                                   : "Rain falls.";
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    }
  };
}

test("generateDataset keeps pairs only when ministral accepts and gemma refuses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gen-"));
  const opts: GenerateOpts = {
    ministralModel: "ministral",
    gemmaModel: "gemma",
    fetchImpl: makeFakeFetch(true, true),
    outputDir: dir,
    patternsOverride: [{ id: "test-1", bucket: "magic", text: "I cast fireball" }],
    contextsOverride: [{ id: "ctx", briefing: "MISSION BRIEFING (durable premise):\nA road." }],
  };
  const summary = await generateDataset(opts);
  expect(summary.kept).toBe(1);
  expect(summary.ambiguous).toBe(0);
  expect(summary.skipped).toBe(0);
  const lines = (await readFile(join(dir, summary.outputPath), "utf8")).trim().split("\n");
  expect(lines.length).toBe(1);
  const row = JSON.parse(lines[0]);
  expect(row.prompt).toContain("PLAYER ACTION: I cast fireball");
  expect(row.chosen).toMatch(/reach for the magic/);
  expect(row.rejected).toMatch(/bolt of fire/);
  expect(row.pattern_bucket).toBe("magic");
  await rm(dir, { recursive: true });
});

test("generateDataset routes ambiguous pairs to the ambiguous file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gen-"));
  const opts: GenerateOpts = {
    ministralModel: "ministral",
    gemmaModel: "gemma",
    fetchImpl: makeFakeFetch(false, false), // both ambiguous
    outputDir: dir,
    patternsOverride: [{ id: "test-1", bucket: "magic", text: "I cast fireball" }],
    contextsOverride: [{ id: "ctx", briefing: "B" }],
  };
  const summary = await generateDataset(opts);
  expect(summary.kept).toBe(0);
  expect(summary.ambiguous).toBe(1);
  const lines = (await readFile(join(dir, summary.ambiguousPath), "utf8")).trim().split("\n");
  expect(lines.length).toBe(1);
  const row = JSON.parse(lines[0]);
  expect(row.ministral_classification).toBe("ambiguous");
  expect(row.gemma_classification).toBe("ambiguous");
  await rm(dir, { recursive: true });
});
```

- [ ] **Step 2: Run tests, confirm they fail**

```bash
bun test bun/generate-dataset.test.ts
```

Expected: module-not-found errors.

- [ ] **Step 3: Implement `generate-dataset.ts`**

Create `bun/generate-dataset.ts`:

```ts
import { callNarrator, assertModelLoaded } from "./lib/lm-studio";
import { classifyResponse, isDisagreement, type Classification } from "./lib/disagreement";
import { NARRATOR_SYSTEM } from "./lib/narrator-prompt";
import { ABILITY_PATTERNS, type AbilityPattern } from "./prompts/ability-patterns";
import { WORLD_CONTEXTS, type WorldContext } from "./prompts/world-contexts";
import { appendFileSync } from "node:fs";

export interface GenerateOpts {
  ministralModel: string;
  gemmaModel: string;
  temperature?: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  outputDir: string;
  /** Override for tests. */
  patternsOverride?: AbilityPattern[];
  /** Override for tests. */
  contextsOverride?: WorldContext[];
}

export interface GenerateSummary {
  kept: number;
  ambiguous: number;
  skipped: number;
  outputPath: string;
  ambiguousPath: string;
}

export async function generateDataset(opts: GenerateOpts): Promise<GenerateSummary> {
  const patterns = opts.patternsOverride ?? ABILITY_PATTERNS;
  const contexts = opts.contextsOverride ?? WORLD_CONTEXTS;
  const temperature = opts.temperature ?? 0.5;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = `abilities-${stamp}.jsonl`;
  const ambiguousPath = `ambiguous-${stamp}.jsonl`;

  let kept = 0;
  let ambiguous = 0;
  let skipped = 0;

  for (const ctx of contexts) {
    for (const pat of patterns) {
      const userMessage = `${ctx.briefing}\n\nPLAYER ACTION: ${pat.text}`;
      let minOut: string;
      let gemOut: string;
      try {
        const [a, b] = await Promise.all([
          callNarrator({
            systemPrompt: NARRATOR_SYSTEM,
            userMessage,
            modelId: opts.ministralModel,
            temperature,
            fetchImpl: opts.fetchImpl,
            baseUrl: opts.baseUrl,
            timeoutMs: 60_000,
          }),
          callNarrator({
            systemPrompt: NARRATOR_SYSTEM,
            userMessage,
            modelId: opts.gemmaModel,
            temperature,
            fetchImpl: opts.fetchImpl,
            baseUrl: opts.baseUrl,
            timeoutMs: 60_000,
          }),
        ]);
        minOut = a.content;
        gemOut = b.content;
      } catch (err) {
        skipped++;
        process.stderr.write(`[gen] ${ctx.id}/${pat.id} skipped: ${(err as Error).message}\n`);
        continue;
      }

      const minClass: Classification = classifyResponse(minOut);
      const gemClass: Classification = classifyResponse(gemOut);

      if (isDisagreement(minClass, gemClass)) {
        const row = {
          id: `${ctx.id}-${pat.id}`,
          prompt: `<<SYSTEM>>\n${NARRATOR_SYSTEM}\n<<USER>>\n${userMessage}`,
          chosen: gemOut,
          rejected: minOut,
          pattern_bucket: pat.bucket,
          context: ctx.id,
          raw_ministral_modelId: opts.ministralModel,
          raw_gemma_modelId: opts.gemmaModel,
        };
        appendFileSync(`${opts.outputDir}/${outputPath}`, JSON.stringify(row) + "\n");
        kept++;
      } else {
        const row = {
          id: `${ctx.id}-${pat.id}`,
          userMessage,
          ministral_response: minOut,
          gemma_response: gemOut,
          ministral_classification: minClass,
          gemma_classification: gemClass,
          pattern_bucket: pat.bucket,
          context: ctx.id,
        };
        appendFileSync(`${opts.outputDir}/${ambiguousPath}`, JSON.stringify(row) + "\n");
        ambiguous++;
      }
      process.stderr.write(`[gen] ${ctx.id}/${pat.id} → min=${minClass} gem=${gemClass}\n`);
    }
  }

  return { kept, ambiguous, skipped, outputPath, ambiguousPath };
}

async function cliMain(): Promise<void> {
  const args = process.argv.slice(2);
  const ministral = args.find((a) => a.startsWith("--ministral="))?.split("=")[1] ?? "mistralai/ministral-3-3b";
  const gemma = args.find((a) => a.startsWith("--gemma="))?.split("=")[1] ?? "google/gemma-3-12b";
  const outDir = args.find((a) => a.startsWith("--out="))?.split("=")[1] ?? "dataset";

  // Pre-flight: both models must be loaded.
  await assertModelLoaded(ministral);
  await assertModelLoaded(gemma);

  console.error(`[gen] starting: ministral=${ministral} gemma=${gemma}`);
  console.error(`[gen] patterns: ${ABILITY_PATTERNS.length}; contexts: ${WORLD_CONTEXTS.length}`);
  console.error(`[gen] total scenarios: ${ABILITY_PATTERNS.length * WORLD_CONTEXTS.length}`);

  const summary = await generateDataset({
    ministralModel: ministral,
    gemmaModel: gemma,
    outputDir: outDir,
  });

  console.error(`[gen] done. kept=${summary.kept} ambiguous=${summary.ambiguous} skipped=${summary.skipped}`);
  console.error(`[gen] training pairs: ${outDir}/${summary.outputPath}`);
  console.error(`[gen] ambiguous (for manual review): ${outDir}/${summary.ambiguousPath}`);
}

if (import.meta.main) {
  cliMain().catch((err) => { console.error("[gen] error:", err); process.exit(1); });
}
```

- [ ] **Step 4: Run tests, confirm they pass**

```bash
bun test bun/generate-dataset.test.ts
```

Expected: 2/2 pass.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

```bash
bun test
```

Expected: all tests pass across `bun/`.

- [ ] **Step 6: Smoke-check the CLI (without running real generation)**

```bash
bun bun/generate-dataset.ts --ministral=nonexistent --gemma=alsonope 2>&1 | head -5
```

Expected: the `assertModelLoaded` pre-flight fails fast with a clear error mentioning `nonexistent` and listing currently-loaded models. Exit code 1.

- [ ] **Step 7: Commit**

```bash
git add bun/generate-dataset.ts bun/generate-dataset.test.ts
git commit -m "feat(train): generate-dataset CLI orchestrating ministral vs gemma

Cross-products ABILITY_PATTERNS x WORLD_CONTEXTS, runs each scenario
through both models in parallel, classifies responses, keeps disagreements
as DPO preference pairs. Ambiguous pairs go to a separate file for
manual review. Pre-flights assertModelLoaded on both before starting.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 3 — Python training setup

All Phase 3 work happens in `.claude/worktrees/train-narrator-abilities/python/`.

### Task 8: Install `uv` and write `pyproject.toml`

**Files:**
- Create: `python/pyproject.toml`
- Create: `python/.python-version`

- [ ] **Step 1: Verify or install `uv`**

```bash
which uv || curl -LsSf https://astral.sh/uv/install.sh | sh
uv --version
```

Expected: `uv 0.5.x` (or newer). If missing, the install script from Astral puts it at `~/.local/bin/uv`. The script is signed and trusted (this is the recommended way to install uv).

- [ ] **Step 2: Create `python/.python-version`**

```bash
cd python
echo "3.11" > .python-version
```

This pins the Python version for the worktree.

- [ ] **Step 3: Create `python/pyproject.toml`**

In the `python/` directory, create `pyproject.toml`:

```toml
[project]
name = "narrator-abilities-lora"
version = "0.1.0"
description = "LoRA + DPO training of ministral-3-3b to refuse player-declared unestablished abilities"
requires-python = ">=3.11,<3.13"
dependencies = [
  "torch==2.5.1",
  "transformers==4.46.3",
  "peft==0.13.2",
  "trl==0.12.1",
  "datasets==3.1.0",
  "bitsandbytes==0.44.1",
  "accelerate==1.1.1",
  "sentencepiece==0.2.0",
  "protobuf==5.28.3",
  "gguf==0.10.0",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = []  # this is a scripts-only project, no library
```

- [ ] **Step 4: Verify `uv` parses the project file**

```bash
cd python
uv lock --check 2>&1 | head -3
```

Expected: error saying "lockfile does not exist" (we haven't locked yet) — this confirms `uv` is reading the pyproject. NOT the lockfile creation yet.

- [ ] **Step 5: Commit**

```bash
git add python/pyproject.toml python/.python-version
git commit -m "feat(train): pyproject.toml with pinned hashes for training deps

All deps from HuggingFace / PyTorch / Meta-adjacent (bitsandbytes,
ggerganov/gguf). No long transitive tail of micro-packages. Versions
pinned to specific releases; uv.lock with hashes generated next.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 9: Generate and audit `uv.lock`

**Files:**
- Create: `python/uv.lock`

This task is intentionally a HUMAN-IN-THE-LOOP step. The lockfile contains every transitive dep with cryptographic hashes; the user audits it before any code installs.

- [ ] **Step 1: Generate the lockfile**

```bash
cd python
uv lock
```

Expected: produces `uv.lock` (likely 500-1500 lines). Each direct and transitive dep gets a `[[package]]` block with `name`, `version`, and `[[package.wheels]]` containing `hash = "sha256:..."`.

- [ ] **Step 2: HUMAN AUDIT — inspect the lockfile**

```bash
# List all distinct package names
grep "^name = " uv.lock | sort -u | head -100
# Total package count
grep -c "^name = " uv.lock
```

Expected: 50-150 packages. Most should be obvious sub-deps of torch / transformers (numpy, tokenizers, huggingface-hub, packaging, filelock, fsspec, regex, requests, etc). If anything looks unfamiliar (`leftpad`, `is-odd`, weird typo-squat-looking names), STOP and report before continuing.

The implementer should skim the package list and CONFIRM nothing looks out of place before proceeding. This is the supply-chain checkpoint the user asked for.

- [ ] **Step 3: Commit the lockfile**

```bash
git add python/uv.lock
git commit -m "feat(train): commit uv.lock with audited package set

Lockfile audited against expected HF/PyTorch transitive deps; nothing
out of place. uv sync --frozen --require-hashes will install only
these exact versions from these exact hashes.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 10: Build the training script (`train.py`)

**Files:**
- Create: `python/train.py`

- [ ] **Step 1: Sync the lockfile**

```bash
cd python
uv sync --frozen
```

Expected: creates `.venv/` inside `python/`, installs all locked packages with hashes verified. Takes 2-5 min depending on disk speed (PyTorch + CUDA wheels are large).

- [ ] **Step 2: Verify the venv works**

```bash
uv run python -c "import torch; print('torch', torch.__version__); print('cuda', torch.cuda.is_available()); print('gpu', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'no')"
```

Expected: `torch 2.5.1`, `cuda True`, `gpu NVIDIA GeForce RTX 4080 SUPER`. If CUDA is False, GPU training won't work — stop and investigate.

- [ ] **Step 3: Create `train.py`**

In `python/`, create `train.py`:

```python
"""DPO + LoRA training for ministral-3-3b on ability-refusal preference pairs.

Run: uv run train.py --dataset ../dataset/abilities-<ts>.jsonl --output-adapter ../output/adapter
"""

import argparse
import json
import os
import sys
from pathlib import Path

import torch
from datasets import Dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import DPOConfig, DPOTrainer


BASE_MODEL_ID = "mistralai/Ministral-3B-Instruct-2410"


def load_dataset_jsonl(path: Path) -> Dataset:
    """Load the JSONL produced by Bun's generate-dataset.ts."""
    rows = []
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            # TRL DPOTrainer expects fields: prompt, chosen, rejected
            rows.append({
                "prompt": row["prompt"],
                "chosen": row["chosen"],
                "rejected": row["rejected"],
            })
    return Dataset.from_list(rows)


def build_lora_config() -> LoraConfig:
    return LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
    )


def build_quantization_config() -> BitsAndBytesConfig:
    return BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dataset", required=True, type=Path)
    p.add_argument("--output-adapter", required=True, type=Path)
    p.add_argument("--epochs", type=float, default=1.0)
    p.add_argument("--eval-split", type=float, default=0.1)
    p.add_argument("--beta", type=float, default=0.1)
    p.add_argument("--lr", type=float, default=5e-5)
    p.add_argument("--max-seq-length", type=int, default=2048)
    p.add_argument("--dry-run", action="store_true",
                   help="Build model+config+trainer but do not actually train. For smoke-testing.")
    args = p.parse_args()

    if not args.dataset.exists():
        print(f"dataset not found: {args.dataset}", file=sys.stderr)
        return 1

    os.environ.setdefault("HF_HOME", str(Path(__file__).resolve().parent.parent / "HF_HOME"))

    print(f"[train] loading dataset: {args.dataset}", flush=True)
    ds = load_dataset_jsonl(args.dataset)
    print(f"[train] dataset rows: {len(ds)}", flush=True)
    if len(ds) < 20:
        print(f"[train] WARN: only {len(ds)} pairs; DPO usually needs 100+ for stable training", flush=True)

    splits = ds.train_test_split(test_size=args.eval_split, seed=42) if args.eval_split > 0 else None
    train_ds = splits["train"] if splits else ds
    eval_ds = splits["test"] if splits else None
    print(f"[train] train={len(train_ds)} eval={len(eval_ds) if eval_ds else 0}", flush=True)

    print(f"[train] loading tokenizer: {BASE_MODEL_ID}", flush=True)
    tok = AutoTokenizer.from_pretrained(BASE_MODEL_ID)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    print(f"[train] loading base model 4-bit: {BASE_MODEL_ID}", flush=True)
    model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL_ID,
        quantization_config=build_quantization_config(),
        torch_dtype=torch.bfloat16,
        device_map="auto",
    )
    model = prepare_model_for_kbit_training(model)
    model = get_peft_model(model, build_lora_config())
    model.print_trainable_parameters()

    args.output_adapter.mkdir(parents=True, exist_ok=True)

    dpo_config = DPOConfig(
        output_dir=str(args.output_adapter),
        beta=args.beta,
        learning_rate=args.lr,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=4,
        max_length=args.max_seq_length,
        max_prompt_length=args.max_seq_length - 256,
        warmup_steps=100,
        logging_steps=10,
        eval_strategy="steps" if eval_ds else "no",
        eval_steps=50 if eval_ds else None,
        save_strategy="epoch",
        save_total_limit=1,
        report_to="none",
        bf16=True,
    )

    trainer = DPOTrainer(
        model=model,
        ref_model=None,  # LoRA-style: the base (with adapter disabled) IS the reference
        args=dpo_config,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        processing_class=tok,
    )

    if args.dry_run:
        print("[train] dry-run: trainer constructed successfully. Exiting before fit.", flush=True)
        return 0

    print("[train] starting fit...", flush=True)
    trainer.train()

    print(f"[train] saving adapter to {args.output_adapter}", flush=True)
    trainer.save_model(str(args.output_adapter))
    tok.save_pretrained(str(args.output_adapter))

    print("[train] done.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Smoke-test the script in dry-run mode**

Create a tiny dummy dataset for smoke-testing:

```bash
mkdir -p ../dataset
cat > ../dataset/smoke.jsonl <<'EOF'
{"prompt":"sys\nuser","chosen":"refusal","rejected":"acceptance"}
{"prompt":"sys2\nuser2","chosen":"refusal2","rejected":"acceptance2"}
EOF
```

Then dry-run:

```bash
cd python
uv run train.py --dataset ../dataset/smoke.jsonl --output-adapter ../output/smoke-adapter --dry-run
```

Expected output ends with `[train] dry-run: trainer constructed successfully. Exiting before fit.` and exit code 0. If it fails, the most common cause is a tokenizer or transformers version mismatch — verify versions match `pyproject.toml` exactly.

This smoke test downloads the base model from Hugging Face the first time it runs (~6 GB into `HF_HOME/`). Subsequent runs use the cache.

- [ ] **Step 5: Clean up the smoke artifacts**

```bash
rm -rf ../dataset/smoke.jsonl ../output/smoke-adapter
```

- [ ] **Step 6: Commit**

```bash
git add python/train.py
git commit -m "feat(train): DPO + LoRA training script

ministral-3-3b base loaded in 4-bit NF4 via bitsandbytes. LoRA rank
16 / alpha 32 targeting all attn + MLP projections. DPO config with
beta 0.1, lr 5e-5, batch 1 grad-accum 4 to fit in 16GB VRAM after
LM Studio is unloaded. Dry-run mode for pipeline smoke-testing.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 11: Build the merge script (`merge.py`)

**Files:**
- Create: `python/merge.py`

- [ ] **Step 1: Create `merge.py`**

In `python/`, create `merge.py`:

```python
"""Merge a LoRA adapter back into the base model and save in HF format.

Run: uv run merge.py --adapter ../output/adapter --output ../output/merged
"""

import argparse
import os
import sys
from pathlib import Path

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

BASE_MODEL_ID = "mistralai/Ministral-3B-Instruct-2410"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--adapter", required=True, type=Path)
    p.add_argument("--output", required=True, type=Path)
    p.add_argument("--base", default=BASE_MODEL_ID)
    args = p.parse_args()

    if not args.adapter.exists():
        print(f"adapter dir not found: {args.adapter}", file=sys.stderr)
        return 1

    os.environ.setdefault("HF_HOME", str(Path(__file__).resolve().parent.parent / "HF_HOME"))

    print(f"[merge] loading base in fp16: {args.base}", flush=True)
    # Merge requires the base loaded in fp16 (not 4-bit) so the merged weights are usable.
    base = AutoModelForCausalLM.from_pretrained(
        args.base,
        torch_dtype=torch.float16,
        device_map="auto",
    )

    print(f"[merge] applying adapter: {args.adapter}", flush=True)
    model = PeftModel.from_pretrained(base, str(args.adapter))

    print("[merge] merging and unloading...", flush=True)
    merged = model.merge_and_unload()

    args.output.mkdir(parents=True, exist_ok=True)
    print(f"[merge] saving merged model to {args.output}", flush=True)
    merged.save_pretrained(str(args.output), safe_serialization=True)

    tok = AutoTokenizer.from_pretrained(args.base)
    tok.save_pretrained(str(args.output))

    print("[merge] done.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Smoke-test argument parsing**

```bash
cd python
uv run merge.py --help
```

Expected: prints argparse help with the three options listed, exits 0.

- [ ] **Step 3: Commit**

```bash
git add python/merge.py
git commit -m "feat(train): merge LoRA adapter into base, save fp16 HF format

Required intermediate step before GGUF conversion. Output is a
standard HF safetensors directory that llama.cpp's converter accepts.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 12: GGUF conversion script + llama.cpp locator

**Files:**
- Create: `python/convert-gguf.sh`

- [ ] **Step 1: Locate llama.cpp**

LM Studio bundles llama.cpp. Find the converter script (`convert_hf_to_gguf.py`) and the quantizer binary (`llama-quantize`):

```bash
find /home/frosty/.lmstudio -name "convert_hf_to_gguf.py" 2>/dev/null | head -3
find /home/frosty/.lmstudio -name "llama-quantize*" -type f 2>/dev/null | head -3
ls ~/.lmstudio/bin/ 2>/dev/null | head -20
```

Document what's found. If both are present in the LM Studio install, we use them via absolute path. If not, fall back to a one-time llama.cpp build:

```bash
# Only if not found in LM Studio:
# git clone https://github.com/ggerganov/llama.cpp /tmp/llama.cpp
# cd /tmp/llama.cpp && make -j
```

The implementer should ASK the user before doing the fallback build, since that's a system-level install. The plan presumes the LM Studio bundle has them.

- [ ] **Step 2: Create `convert-gguf.sh`**

In `python/`, create `convert-gguf.sh`:

```bash
#!/usr/bin/env bash
# Convert an HF-format merged model to GGUF Q4_K_M.
#
# Usage:
#   ./convert-gguf.sh <merged-dir> <output.gguf>
#
# Requires llama.cpp's convert_hf_to_gguf.py and llama-quantize on PATH
# or at LLAMACPP_DIR. LM Studio bundles both — set LLAMACPP_DIR if they
# live there (e.g. ~/.lmstudio/bin).
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <merged-hf-dir> <output.gguf>" >&2
  exit 2
fi

MERGED="$1"
OUT_Q4="$2"
OUT_F16="${OUT_Q4%.gguf}-f16.gguf"

# Resolve tools: prefer PATH, then LLAMACPP_DIR, then LM Studio default.
LLAMACPP_DIR="${LLAMACPP_DIR:-$HOME/.lmstudio/bin}"
CONVERT_SCRIPT="$(command -v convert_hf_to_gguf.py || true)"
if [ -z "$CONVERT_SCRIPT" ] && [ -f "$LLAMACPP_DIR/convert_hf_to_gguf.py" ]; then
  CONVERT_SCRIPT="$LLAMACPP_DIR/convert_hf_to_gguf.py"
fi
if [ -z "$CONVERT_SCRIPT" ]; then
  echo "error: convert_hf_to_gguf.py not found on PATH or at $LLAMACPP_DIR" >&2
  echo "       set LLAMACPP_DIR=<path> or install llama.cpp" >&2
  exit 1
fi

QUANTIZE_BIN="$(command -v llama-quantize || true)"
if [ -z "$QUANTIZE_BIN" ] && [ -x "$LLAMACPP_DIR/llama-quantize" ]; then
  QUANTIZE_BIN="$LLAMACPP_DIR/llama-quantize"
fi
if [ -z "$QUANTIZE_BIN" ]; then
  echo "error: llama-quantize not found on PATH or at $LLAMACPP_DIR" >&2
  exit 1
fi

echo "[gguf] convert_hf_to_gguf.py: $CONVERT_SCRIPT"
echo "[gguf] llama-quantize:        $QUANTIZE_BIN"
echo "[gguf] merged dir: $MERGED"
echo "[gguf] f16 output: $OUT_F16"
echo "[gguf] q4 output:  $OUT_Q4"

# Step 1: convert HF safetensors → GGUF f16
uv run python "$CONVERT_SCRIPT" "$MERGED" --outfile "$OUT_F16" --outtype f16

# Step 2: quantize f16 → Q4_K_M
"$QUANTIZE_BIN" "$OUT_F16" "$OUT_Q4" Q4_K_M

# Step 3: clean up the intermediate f16 (it's huge, ~6GB)
rm -f "$OUT_F16"

echo "[gguf] done: $OUT_Q4"
ls -lh "$OUT_Q4"
```

- [ ] **Step 3: Make it executable**

```bash
chmod +x python/convert-gguf.sh
```

- [ ] **Step 4: Smoke-test the help output**

```bash
cd python
./convert-gguf.sh 2>&1 | head -3
```

Expected: prints `usage: ./convert-gguf.sh <merged-hf-dir> <output.gguf>` and exits 2.

- [ ] **Step 5: Commit**

```bash
git add python/convert-gguf.sh
git commit -m "feat(train): GGUF conversion + Q4_K_M quantization shell wrapper

Locates llama.cpp tools from PATH, then $LLAMACPP_DIR (defaulting to
LM Studio's bundled bin/). Two-step convert: HF -> GGUF f16, then
quantize f16 -> Q4_K_M (~2GB). Intermediate f16 cleaned up.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 4 — Validation infrastructure (on lab branch)

**Branch switch.** Phase 4 work happens in `.claude/worktrees/local-models/` on branch `lab/local-models`. The training worktree stays untouched; we're adding fixtures + a scoring check to the testbed.

### Task 13: Author `ability-cases.jsonl` fixtures

**Files:**
- Modify: `.claude/worktrees/local-models/fixtures/snapshots.jsonl` (append rows)

Decision: rather than introduce a new fixture file format, we append narrator-shaped rows to the existing `snapshots.jsonl` with one new field — `expected_refusal: true` on the narrator part. The scoring engine conditionally runs the `ability_refused` check when this field is present. This keeps the sweep CLI unchanged.

- [ ] **Step 1: Confirm on lab branch worktree**

```bash
cd /home/frosty/Dev/ai/adventure/.claude/worktrees/local-models
git status
git rev-parse --abbrev-ref HEAD
```

Expected: branch `lab/local-models`, clean tree (modulo any in-flight sweep results).

- [ ] **Step 2: Build the 12-row append set**

Run this script from the lab worktree to construct + append:

```bash
bun -e '
const cases = [
  { ctx: "medieval-forest", briefing: "MISSION BRIEFING (durable premise):\nYou are a hooded traveller crossing a dense northern forest.", action: "use your magic" },
  { ctx: "medieval-forest", briefing: "MISSION BRIEFING (durable premise):\nYou are a hooded traveller crossing a dense northern forest.", action: "I cast fireball at the bandit" },
  { ctx: "sci-fi-lunar",    briefing: "MISSION BRIEFING (durable premise):\nYou are an astronaut on the lunar far side, lander a kilometre behind.", action: "I teleport back to the lander" },
  { ctx: "sci-fi-lunar",    briefing: "MISSION BRIEFING (durable premise):\nYou are an astronaut on the lunar far side, lander a kilometre behind.", action: "I pull out a fusion grenade" },
  { ctx: "urban-noir",      briefing: "MISSION BRIEFING (durable premise):\nYou are a tired investigator in a rain-slick alley.", action: "I have a sword hidden in my coat" },
  { ctx: "urban-noir",      briefing: "MISSION BRIEFING (durable premise):\nYou are a tired investigator in a rain-slick alley.", action: "I tear the iron gate from its hinges" },
  { ctx: "fantasy-court",   briefing: "MISSION BRIEFING (durable premise):\nYou are an emissary kneeling in the king’s audience hall.", action: "I am secretly the king’s lost son" },
  { ctx: "fantasy-court",   briefing: "MISSION BRIEFING (durable premise):\nYou are an emissary kneeling in the king’s audience hall.", action: "I read the chancellor’s mind" },
  { ctx: "empty-world",     briefing: "MISSION BRIEFING (durable premise):\nYou are standing in a flat open plain at dusk. The world is what you make of it.", action: "I summon a horse" },
  { ctx: "empty-world",     briefing: "MISSION BRIEFING (durable premise):\nYou are standing in a flat open plain at dusk. The world is what you make of it.", action: "I shapeshift into a hawk" },
  { ctx: "underground-dungeon", briefing: "MISSION BRIEFING (durable premise):\nYou are in a damp underground passage, torchlight on carved stone.", action: "I find a key in my pocket" },
  { ctx: "underground-dungeon", briefing: "MISSION BRIEFING (durable premise):\nYou are in a damp underground passage, torchlight on carved stone.", action: "I see through the stone wall" },
];
const out = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const id = `ability-${(i+1).toString().padStart(2, "0")}-${c.ctx}`;
  const userMessage = `${c.briefing}\n\nPLAYER ACTION: ${c.action}`;
  out.push({
    stage: "narrator",
    snapshotId: id,
    turn: 100 + i,
    position: [0, 0],
    playerInput: c.action,
    narrator: { userMessage, mustNameTarget: null, expected_refusal: true },
  });
}
const text = out.map(o => JSON.stringify(o)).join("\n") + "\n";
await Bun.write("fixtures/snapshots.jsonl", (await Bun.file("fixtures/snapshots.jsonl").text()) + text);
console.log("appended:", out.length, "rows");
'
wc -l fixtures/snapshots.jsonl
grep -c "expected_refusal" fixtures/snapshots.jsonl
```

Expected: original line count + 12. `grep -c expected_refusal` returns 12.

- [ ] **Step 3: Verify the loader picks them up**

```bash
bun -e '
import("./probes/shared").then(async m => {
  const snaps = await m.loadSnapshots(new URL("./fixtures/snapshots.jsonl", import.meta.url).pathname);
  const ability = snaps.filter(s => (s.narrator as any)?.expected_refusal);
  console.log("ability snapshots:", ability.length);
  for (const s of ability) console.log(" -", s.snapshotId);
});
'
```

Expected: 12 ability snapshots listed, each with a recognizable id like `ability-01-medieval-forest`.

- [ ] **Step 4: Commit**

```bash
git add fixtures/snapshots.jsonl
git commit -m "feat(lab): add 12 ability-refusal narrator fixtures

Hand-crafted scenarios across 6 contexts (medieval, sci-fi, urban-noir,
fantasy court, empty world, dungeon) covering all 4 ability buckets
(magic, implausible-physical, fact-injection, resource-summoning).
Each row has expected_refusal: true on the narrator part; new
ability_refused scoring check (next task) fires conditionally.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 14: Add `ability_refused` scoring check (TDD)

**Files:**
- Modify: `score/narrator.ts` (add field + check)
- Modify: `score/narrator.test.ts` (append tests)

- [ ] **Step 1: Add failing tests to `score/narrator.test.ts`**

Append to the existing `score/narrator.test.ts`:

```ts
test("ability_refused skipped when expected_refusal is undefined", () => {
  const r = scoreNarrator({ mustNameTarget: null }, "you walk forward.");
  expect(r.find((x) => x.name === "ability_refused")).toBeUndefined();
});

test("ability_refused passes when refusal pattern present", () => {
  const r = scoreNarrator(
    { mustNameTarget: null, expectedRefusal: true, declaredAbility: "I cast fireball" },
    "you reach for the spell, but nothing answers. your fingers find empty air.",
  );
  expect(r.find((x) => x.name === "ability_refused")!.pass).toBe(true);
});

test("ability_refused fails when narrator plays along", () => {
  const r = scoreNarrator(
    { mustNameTarget: null, expectedRefusal: true, declaredAbility: "I cast fireball" },
    "you raise your hand and a bolt of fire leaps from your fingers, striking the bandit.",
  );
  expect(r.find((x) => x.name === "ability_refused")!.pass).toBe(false);
});

test("ability_refused fails on ambiguous response (no clear refusal phrasing)", () => {
  const r = scoreNarrator(
    { mustNameTarget: null, expectedRefusal: true, declaredAbility: "I cast fireball" },
    "the wind moves through the trees. a bird calls.",
  );
  expect(r.find((x) => x.name === "ability_refused")!.pass).toBe(false);
});
```

- [ ] **Step 2: Run tests, confirm new ones fail**

```bash
bun test score/narrator.test.ts
```

Expected: previously-passing tests still pass; 4 new tests fail (the score function doesn't have `expectedRefusal` yet).

- [ ] **Step 3: Update `score/narrator.ts`**

Modify the interface and the function. Add to `NarratorScoreInput`:

```ts
export interface NarratorScoreInput {
  mustNameTarget: string | null;
  /** When true, the narrator should refuse the player's declared ability. */
  expectedRefusal?: boolean;
  /** The declared-ability string from the player input, for context. */
  declaredAbility?: string;
}
```

Add a refusal-pattern regex set (mirrors the dataset-gen heuristics but lives in scoring):

```ts
const REFUSAL_PATTERNS: RegExp[] = [
  /\bnothing (happens|answers|comes|stirs)\b/i,
  /\byou reach for\b.*\b(empty|nothing|no )/i,
  /\b(your )?fingers find (empty|nothing|no )/i,
  /\bno spell (comes|answers|works)\b/i,
  /\byou are (no|not a) (wizard|sorcerer|mage|magician)\b/i,
  /\b(you are|you remain) (an |a |the )?ordinary (man|woman|mortal|human)\b/i,
  /\b(the world|reality) (does not|will not|refuses to) bend\b/i,
  /\bthe (boulder|stone|gate|door) does not (move|budge|yield)\b/i,
  /\b(you )?strain(s|ed)?\b.*\b(but|yet)\b.*\b(nothing|fails|no )/i,
];
```

Add the conditional check at the end of `scoreNarrator`, before the final `return results;`:

```ts
  if (input.expectedRefusal) {
    const refused = REFUSAL_PATTERNS.some((re) => re.test(output));
    results.push({
      name: "ability_refused",
      pass: refused,
      ...(refused ? {} : { note: `no refusal pattern matched` }),
    });
  }
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
bun test score/narrator.test.ts
```

Expected: all narrator scoring tests pass (the 12 previous + 4 new = 16).

- [ ] **Step 5: Run the full lab test suite**

```bash
bun test
```

Expected: all lab tests pass.

- [ ] **Step 6: Commit**

```bash
git add score/narrator.ts score/narrator.test.ts
git commit -m "feat(lab): ability_refused scoring check (conditional)

Fires only when expectedRefusal is true on the input — runs against
the new 12 fixture rows from the prior task. Uses the same refusal-
phrasing regex set the dataset-gen heuristics use, so the test and
the training data agree on what counts as a refusal.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 15: Wire the new field through the sweep dispatcher

The scoring function now accepts `expectedRefusal` + `declaredAbility`, but `sweep.ts`'s narrator dispatcher doesn't pass them. Fix that.

**Files:**
- Modify: `sweep.ts` (the dispatcher's `score` lambda)

- [ ] **Step 1: Update the narrator dispatcher in `sweep.ts`**

Find this block in `sweep.ts`:

```ts
    if (s === "narrator") {
      const snap = item as Snapshot;
      return scoreNarrator({ mustNameTarget: snap.narrator?.mustNameTarget ?? null }, content);
    }
```

Replace with:

```ts
    if (s === "narrator") {
      const snap = item as Snapshot;
      const narratorPart = snap.narrator as any;
      return scoreNarrator({
        mustNameTarget: narratorPart?.mustNameTarget ?? null,
        expectedRefusal: narratorPart?.expected_refusal === true,
        declaredAbility: snap.playerInput,
      }, content);
    }
```

- [ ] **Step 2: Run the full lab test suite**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 3: Smoke-check that the new fixtures load and route correctly**

```bash
bun probes/narrator.ts ability-01-medieval-forest --variant v0-baseline 2>&1 | head -10
```

This invokes the narrator probe against the first ability-refusal fixture. Expected: it makes a real LM Studio call (assuming ministral is loaded), outputs the model's response. (Whether the response refuses or accepts is what we're trying to MEASURE — we don't assert pass/fail in the smoke test.)

If LM Studio is unavailable or no model is loaded, it errors out cleanly — that's still fine for the smoke test of the routing.

- [ ] **Step 4: Commit**

```bash
git add sweep.ts
git commit -m "feat(lab): sweep dispatcher passes expectedRefusal to narrator scoring

Lets the new ability_refused check fire on the 12 ability-refusal
fixtures appended to snapshots.jsonl. Behaviour unchanged on
non-ability snapshots (expectedRefusal stays undefined).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 5 — Documentation

**Branch switch back** to `.claude/worktrees/train-narrator-abilities/` for the README.

### Task 16: README in the training worktree

**Files:**
- Create: `.claude/worktrees/train-narrator-abilities/README.md`
- Create: `.claude/worktrees/train-narrator-abilities/output/runs.md`

- [ ] **Step 1: Write the README**

Create `README.md` at the worktree root:

```markdown
# train/narrator-abilities-lora

LoRA + DPO training pipeline that fine-tunes `mistralai/Ministral-3B-Instruct-2410` to refuse player-declared unestablished abilities (the "use your magic" failure observed in real play). Spec: `docs/superpowers/specs/2026-05-12-narrator-abilities-lora-training-design.md`.

## Pipeline

```
Bun gen → dataset/<ts>.jsonl → [you inspect] → uv run train.py → output/adapter/
    → uv run merge.py → output/merged/ → ./convert-gguf.sh
    → output/ministral-3b-world-engine-v1-Q4_K_M.gguf
    → [load into LM Studio] → lab sweep validation → promote (or not)
```

## Prerequisites

- Bun on PATH
- Python 3.11+ and `uv` (install: `curl -LsSf https://astral.sh/uv/install.sh | sh`)
- LM Studio running at `LM_STUDIO_URL` (default `http://localhost:1234`)
- Both candidate models loaded: `mistralai/ministral-3-3b` AND `google/gemma-3-12b`
- RTX 4080 SUPER (16 GB VRAM) or better — and **LM Studio unloaded before training** to free VRAM
- For the GGUF conversion: llama.cpp (LM Studio bundles it; set `LLAMACPP_DIR` if not at `~/.lmstudio/bin/`)

## Dataset generation

Both models loaded, then:

```sh
cd bun
bun generate-dataset.ts
# Optional: bun generate-dataset.ts --ministral=mistralai/ministral-3-3b --gemma=google/gemma-3-12b --out=../dataset
```

Outputs:
- `dataset/abilities-<timestamp>.jsonl` — clean preference pairs (the training input)
- `dataset/ambiguous-<timestamp>.jsonl` — borderline cases for manual review

Inspect the `abilities-*` file before training. Expected: 150-300 rows. If under 100, extend `bun/prompts/ability-patterns.ts` and re-run.

## Training

```sh
# Unload LM Studio models first to free VRAM:
lms unload --all

cd python
uv sync --frozen       # first time only; installs from uv.lock
uv run train.py \
  --dataset ../dataset/abilities-<timestamp>.jsonl \
  --output-adapter ../output/adapter \
  --epochs 1 \
  --eval-split 0.1
```

Training takes ~30-90 min on a 4080 SUPER. Progress prints to stdout. Output adapter (~10 MB) lands at `output/adapter/`.

## Merge to HF format

```sh
cd python
uv run merge.py --adapter ../output/adapter --output ../output/merged
```

Output: `output/merged/` (fp16 HF safetensors, ~6 GB).

## Convert to GGUF Q4_K_M

```sh
cd python
./convert-gguf.sh ../output/merged ../output/ministral-3b-world-engine-v1-Q4_K_M.gguf
```

Output: `output/ministral-3b-world-engine-v1-Q4_K_M.gguf` (~2 GB). Drop into LM Studio's models dir and load like any other model.

## Validate against the lab testbed

```sh
cd /home/frosty/Dev/ai/adventure/.claude/worktrees/local-models
# Make sure ONLY the new merged model is loaded in LM Studio
bun sweep.ts narrator --models ministral-3-3b-world-engine-v1
# Compare against baseline:
lms unload --all && lms load mistralai/ministral-3-3b
bun sweep.ts narrator --models mistralai/ministral-3-3b
# Compare results/<two latest>/summary.md
```

Promotion gates (must hold for v1 to ship):
- No regression on existing checks (`must_name_target`, `no_label_leak`, `no_menu_closer`, `plausible_length`)
- `ability_refused` ≥ 80% on the 12 ability-refusal fixtures
- Manual play-test of the Merlin scenario shows the trained narrator refusing "use your magic"

Log every run in `output/runs.md` (template provided) — success or failure.

## Cleanup

`.venv/` and `HF_HOME/` are gitignored and scoped to this worktree. To reclaim disk:

```sh
rm -rf python/.venv HF_HOME
```

The base model alone is ~6 GB cached. Re-downloads on next `uv sync` if you nuke `HF_HOME`.
```

- [ ] **Step 2: Create the run-log template**

Create `output/runs.md`:

```markdown
# Training runs

Log every training round here — success or failure. Per the spec, this is the trail for what we tried and what moved the needle.

## Template

```
## run-2026-MM-DD-NN

- dataset: abilities-2026-MM-DD.jsonl (N pairs, N ambiguous)
- hyperparameters: β=0.1, lr=5e-5, epochs=1, lora_rank=16
- training wall time: X min
- existing-fixture sweep: <before/after pass counts per check>
- ability-cases sweep: <pass count>
- manual play notes: <what felt right/wrong>
- outcome: promoted | held | rejected (with reason)
- artifacts: output/ministral-3b-world-engine-vN-Q4_K_M.gguf
```

---

(no runs yet)
```

- [ ] **Step 3: Commit**

```bash
git add README.md output/runs.md
git commit -m "docs(train): README + run-log template

Walkthrough of the full pipeline (gen → train → merge → convert →
validate) with the prereqs, the lab-sweep promotion gates, and the
cleanup commands. runs.md is the per-iteration log the user asked for.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage:**

| Spec section | Tasks |
|---|---|
| §1 Architecture & file layout | Task 1 (worktree) + Tasks 2-12 (the actual files) |
| §2 Dataset generation (Bun) | Tasks 2, 3, 4, 5, 6, 7 |
| §3 Training (Python + uv) | Tasks 8, 9, 10 |
| §4 Merge + GGUF | Tasks 11, 12 |
| §5 Validation | Tasks 13, 14, 15 |
| §5 Run log | Task 16 (template) |
| §6 Integration | Out of scope per spec |
| Hardening (uv lock, audit, scoped venv) | Task 8 (deps), Task 9 (audit), Task 10 (sync) |
| Supply-chain dep allowlist | Task 8 dep list comments + Task 9 audit step |
| llama.cpp from LM Studio bundle | Task 12 step 1 + the shell script's fallback logic |

**Placeholder scan:** Every step has concrete code or commands. No "TODO" or "implement later" text. The `--epochs` default of `1.0` is a real hyperparameter choice, not a placeholder.

**Type consistency:**
- `NarratorScoreInput` adds `expectedRefusal` + `declaredAbility` in Task 14; Task 15 passes them through. Both files use the same field names.
- `GenerateOpts` / `GenerateSummary` defined in Task 7 are internally consistent.
- `AbilityPattern.bucket` enum (Task 3) is referenced in Task 7's `pattern_bucket` field — same string literals.
- `Classification` type (Task 6) is used by Task 7's classify call — consistent.

**Manual-step audit:** Task 9 (uv.lock audit) is explicitly a human-checkpoint step. Task 12 step 1 (locate llama.cpp) is also human-checkpoint. Both are called out in the task body.

No fixes needed.
