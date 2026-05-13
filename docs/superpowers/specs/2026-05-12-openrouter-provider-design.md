# OpenRouter provider — design

**Date:** 2026-05-12
**Status:** Approved for planning

## Problem

Local Nemotron is great for rule-following but slow on consumer hardware; turning thinking on makes it slower. Gemini gives fast remote prose but costs money. OpenRouter now serves a free Nemotron variant (`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`) that's fast cloud-side and follows the same rules the local Nemotron does — potentially the "best of both" path for users without LM Studio.

We need OpenRouter as a first-class provider option, available to all three stages (narrator, interpreter, **and archivist** — which is currently locked to local).

## Goals

- Add `openrouter` as a peer of `local` and `gemini` for narrator and interpreter routing.
- Lift the archivist's hardcoded-local constraint by introducing `ARCHIVIST_PROVIDER` (default `local`).
- Surface the option clearly in `.env-sample` as the free-cloud preset, right after the Gemini paid-cloud block.
- Default thinking-mode ON for OpenRouter Nemotron (rule-following matters), with per-stage env toggles to flip off for speed.
- Validator catches missing key / invalid value with a friendly message matching the Gemini pattern.

## Non-goals

- README rewrite (env-sample carries the story for now).
- Config-screen UI (see [[project_idea_config_screen]]).
- Cost/usage ledger (see [[project_idea_in_session_cost_display]]).
- Auto-fallback between providers on error — failures stay explicit.

## Architecture

Three peer providers, no special-casing:

| Stage       | Env var                | Valid values                       | Default |
|-------------|------------------------|------------------------------------|---------|
| Narrator    | `NARRATOR_PROVIDER`    | `local` \| `gemini` \| `openrouter`| `local` |
| Interpreter | `INTERPRETER_PROVIDER` | `local` \| `gemini` \| `openrouter`| `local` |
| Archivist   | `ARCHIVIST_PROVIDER`   | `local` \| `openrouter`            | `local` |

(Archivist intentionally excludes `gemini` — that pairing was never wired and isn't part of this change.)

### Env surface (added to `.env-sample`)

```
## --- OPENROUTER (free cloud, no local model needed) ---
## OPENROUTER_API_KEY=
## NARRATOR_PROVIDER=openrouter
## INTERPRETER_PROVIDER=openrouter
## ARCHIVIST_PROVIDER=openrouter
##
## Single model knob covers all three stages.
## Override per-stage with OPENROUTER_NARRATOR_MODEL / _INTERPRETER_MODEL / _ARCHIVIST_MODEL.
## OPENROUTER_MODEL=nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
##
## Thinking mode is ON by default for this Nemotron (slower, follows rules better).
## Flip OFF per stage if you want speed:
## OPENROUTER_NARRATOR_THINKING=off
## OPENROUTER_INTERPRETER_THINKING=off
## OPENROUTER_ARCHIVIST_THINKING=off
```

Gemini block stays put, relabeled as the paid/best-prose option. OpenRouter block is appended after it.

## Code shape (`src/api.ts`)

OpenRouter speaks the same OpenAI-compatible `/v1/chat/completions` shape as LM Studio, so each existing local call gets a sibling that targets `https://openrouter.ai/api/v1/chat/completions`.

### New constants

```
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
const OPENROUTER_NARRATOR_MODEL    = process.env.OPENROUTER_NARRATOR_MODEL    ?? OPENROUTER_MODEL;
const OPENROUTER_INTERPRETER_MODEL = process.env.OPENROUTER_INTERPRETER_MODEL ?? OPENROUTER_MODEL;
const OPENROUTER_ARCHIVIST_MODEL   = process.env.OPENROUTER_ARCHIVIST_MODEL   ?? OPENROUTER_MODEL;

// Thinking ON by default; "off" disables. Any other value defaults to on.
const OPENROUTER_NARRATOR_THINKING    = (process.env.OPENROUTER_NARRATOR_THINKING    ?? "on").toLowerCase() !== "off";
const OPENROUTER_INTERPRETER_THINKING = (process.env.OPENROUTER_INTERPRETER_THINKING ?? "on").toLowerCase() !== "off";
const OPENROUTER_ARCHIVIST_THINKING   = (process.env.OPENROUTER_ARCHIVIST_THINKING   ?? "on").toLowerCase() !== "off";

const ARCHIVIST_PROVIDER = (process.env.ARCHIVIST_PROVIDER ?? "local").toLowerCase();
```

### Three new call functions

Each mirrors its local sibling but:
- POSTs to `OPENROUTER_URL`
- Adds `Authorization: Bearer ${OPENROUTER_API_KEY}` header
- Uses the per-stage model id
- Includes `reasoning: { effort: thinking ? "medium" : "off" }` (`medium` chosen as the conservative default; if Nemotron's `high` is needed for harder rule-following we'll bump in a follow-up rather than expose a third env knob now)
- Reads `content` first, falls back to `reasoning_content` (OpenRouter normalizes JSON into `content`)

```
async function callNarratorOpenRouter(systemPrompt, input): Promise<string>
async function callInterpreterOpenRouter<T>(systemPrompt, input, schema): Promise<T>
async function callArchivistOpenRouter<T>(systemPrompt, input, schemaName, schema): Promise<T>
```

Timeouts match the local equivalents (30s narrator/interpreter, 60s archivist). If real-world latency on the free tier exceeds these, bump in a follow-up.

### Routing in existing dispatchers

- `callModel` — current `if (NARRATOR_PROVIDER === "gemini")` short-circuit gains a peer `else if (NARRATOR_PROVIDER === "openrouter")` branch.
- `callInterpreterStructured` — same pattern, peer `openrouter` branch.
- `callModelStructured` (archivist) — currently always-local; now reads `ARCHIVIST_PROVIDER` and routes to `callArchivistOpenRouter` when set. The existing 3-retry wrapper applies to both paths (transient-failure retry is provider-agnostic).

### Validator updates (`validateApiConfig`)

- `VALID_PROVIDERS = ["local", "gemini", "openrouter"]` for narrator/interpreter.
- New `VALID_ARCHIVIST_PROVIDERS = ["local", "openrouter"]` validated separately.
- Add `ARCHIVIST_PROVIDER` to the validation loop.
- New check: if any stage is set to `openrouter` and `OPENROUTER_API_KEY` is missing, print the offending stage list and exit — same shape as the existing Gemini check.

### Logging

`logStage` already takes a `provider` string. The startup banner naturally extends:
```
[api] [narrator]    [openrouter] [nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free]
[api] [archivist]   [openrouter] [nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free]
[api] [interpreter] [openrouter] [nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free]
```

The current `where` derivation in `logStage` (`provider === "gemini" ? "remote" : "local"`) becomes a three-way switch: `openrouter` → `"openrouter"`, `gemini` → `"remote"`, else `"local"`.

## Edge cases

**Free-tier rate limits.** OpenRouter free tier caps around 20 req/min, 50/day uncredited (1000/day with $10 credit). A 429 surfaces a clear message ("OpenRouter rate limit hit — wait a minute or add credits"). No auto-retry on 429 — existing archivist 3× retry stays for transient failures only.

**Reasoning leakage into prose.** Nemotron's `reasoning_content` can hold scratchpad. OpenRouter normalizes JSON into `content`, so archivist reads `content` first, falls back to `reasoning_content`. Narrator reads `content` first (correct for prose).

**Empty content with thinking on.** Per [[project_thinking_models_unsuitable]], reasoning models can burn the budget on scratchpad and return empty content. Existing `MAX_TOKENS=2500` gives Nemotron headroom; if we see empty-content failures in practice, the per-stage env toggle to flip thinking off is already there.

**Model-id typos.** OpenRouter returns 400 with `{"error": {"message": "..."}}`. Surface the message verbatim.

**Provider value invalid.** Validator catches at startup (same as today's check for invalid narrator/interpreter providers).

## Testing approach

- **Unit:** mock `fetch`; verify the OpenRouter path sends correct URL, `Authorization` header, model id, and `reasoning.effort` flag toggled by the thinking env var.
- **Validator:** any stage on openrouter + missing key → exits with the expected friendly message; `ARCHIVIST_PROVIDER=gemini` → exits with "must be local or openrouter".
- **Manual smoke:** one full turn with all 3 stages on openrouter + thinking on; then again with all thinking off. Confirm narrator prose looks right, archivist JSON parses, interpreter direction parses. Run before declaring complete.

## Files touched

- `.env-sample` — append OpenRouter block; relabel Gemini block as "paid cloud, best prose".
- `src/api.ts` — new constants, three new call functions, routing branches in three dispatchers, validator updates, `logStage` 3-way `where`.

No other files touched. No new modules.

## Memory references

- [[project_thinking_models_unsuitable]] — thinking models can return empty content; mitigation = per-stage off toggle.
- [[project_nemotron_omni_q3_native_refusals]] — Nemotron's native refusal behavior is the reason this matters.
- [[feedback_nemotron_thinking_directive]] — "detailed thinking off" directive doesn't survive LM Studio's chat template; OpenRouter exposes a proper API field so this constraint doesn't apply here.
- [[project_idea_config_screen]] — future home for a GUI picker that uses these env vars.
