# `.env` Reorganization — Design Spec

**Date:** 2026-05-13
**Status:** Approved, ready for implementation plan
**Phase:** 1 of 2 (Phase 2 = LLM dispatcher + workers, separate spec)

## Goal

Collapse the current sprawling `.env` (15+ provider-related variables across `LOCAL_*`, `GEMINI_*`, `OPENROUTER_*`, three `<STAGE>_PROVIDER` strings) into a small, opinionated configuration where each pipeline stage declares its provider and model on a single line. Drop Gemini as a text-generation provider entirely — Gemini becomes an opt-in service for images and TTS only. The goal is a `.env-sample` a new user can scan in 10 seconds and understand.

## Non-goals (Phase 2 territory)

- LLM dispatcher / worker processes.
- Startup probes that verify provider reachability.
- A config screen in the web UI.
- Per-provider HTTP connection pooling beyond what's already implicit in Bun's `fetch`.

## Architecture

One new file: `src/config.ts`. Exports a typed `Config` object and a `loadConfig()` function. All `process.env` reads in the codebase migrate to this file (with one explicit exception: `SNAPSHOT_FIXTURES` in `src/engine.ts` is a test-only knob, untouched by this work).

`src/api.ts`, `src/server.ts`, and the TTS/image route handlers import `Config` instead of reading env directly. `config.ts` knows nothing about HTTP, providers' wire formats, or how stages are dispatched. It parses strings into a typed object and hard-fails on malformed input. `src/api.ts` keeps its provider-call logic but consumes `Config` for routing decisions.

No backward compatibility for the old env format. Clean break. `.env-sample` becomes the authoritative reference.

## Config schema

```typescript
type Provider = "local" | "openrouter";

type StageConfig = {
  provider: Provider;
  model: string;          // required, no defaulting
  temperature?: number;   // hidden override, undefined = let model pick
  topP?: number;          // hidden override
};

type Config = {
  lmStudioUrl: string;            // default: "http://localhost:1234"
  openRouterApiKey: string | null;
  geminiApiKey: string | null;
  narrator: StageConfig;
  archivist: StageConfig;
  interpreter: StageConfig;
  useGeminiImages: boolean;
  useGeminiNarration: boolean;
};
```

The `Provider` type intentionally excludes `"gemini"`. Gemini is no longer a text-generation option.

## The new `.env-sample`

```bash
# Required for any stage with provider=local
LM_STUDIO_URL=http://localhost:1234

# Required for any stage with provider=openrouter
OPENROUTER_API_KEY=

# One line per pipeline stage: provider,model
# provider must be one of: local, openrouter
# model is the exact id sent to that provider
NARRATOR_PROVIDER=openrouter,nvidia/nemotron-3-nano
ARCHIVIST_PROVIDER=local,nvidia/nemotron-3-nano
INTERPRETER_PROVIDER=local,nvidia/nemotron-3-nano

# Required if either USE_GEMINI_* flag below is true
GEMINI_API_KEY=

# Opt-in cloud features (each requires GEMINI_API_KEY)
USE_GEMINI_IMAGES=true
USE_GEMINI_NARRATION=true
```

## Parsing rules

### `<STAGE>_PROVIDER` (NARRATOR_PROVIDER, ARCHIVIST_PROVIDER, INTERPRETER_PROVIDER)

1. Read raw string. Absent or empty → hard-fail: `"NARRATOR_PROVIDER is required. Format: provider,model (e.g. openrouter,nvidia/nemotron-3-nano)"`.
2. Strip optional surrounding brackets: `[openrouter, nvidia/nemotron-3-nano]` → `openrouter, nvidia/nemotron-3-nano`. Brackets are accepted for human-friendliness but optional.
3. Split on the first comma. No comma → hard-fail with the same format example.
4. Trim whitespace on both halves. If either side is empty → hard-fail.
5. Validate provider ∈ `{"local", "openrouter"}` → else hard-fail with the valid set listed.
6. No validation of the model string. Models like `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` are too varied to whitelist. Trust the user; the provider call surfaces wrong-model errors clearly enough.

### `USE_GEMINI_IMAGES`, `USE_GEMINI_NARRATION`

Strict boolean: `"true"` (case-insensitive) is the only truthy value. Anything else, including unset, is `false`. No `1`/`yes`/`on` aliasing.

### `LM_STUDIO_URL`

Default `"http://localhost:1234"` if unset. Otherwise trim trailing slash, use as-is.

### Hidden overrides

`LOCAL_<STAGE>_TEMP` and `LOCAL_<STAGE>_TOP_P` parsed as floats. Missing, empty, or unparseable → `undefined` (not an error). When `undefined`, the call omits the parameter and the local model uses its own default. These knobs do not appear in `.env-sample`; they exist for debugging.

## Validation behavior

`loadConfig()` runs once at server startup, called from `src/server.ts:main()` (currently `validateApiConfig()` lives in `src/api.ts` — relocates to `config.ts`).

On any failure, `loadConfig()`:

1. Collects **all** validation errors (does not exit on first).
2. Prints each as a `[config]` line to `console.error`.
3. Calls `process.exit(1)`.

This way a user with three misconfigured fields sees three errors, not one-at-a-time.

### Validation rules

| Condition | Error message |
|---|---|
| Any `<STAGE>_PROVIDER` missing or malformed | `[config] NARRATOR_PROVIDER missing/invalid. Format: provider,model (e.g. openrouter,nvidia/nemotron-3-nano)` |
| Any stage's provider is `openrouter` AND `OPENROUTER_API_KEY` is empty | `[config] NARRATOR_PROVIDER=openrouter but OPENROUTER_API_KEY is empty. Get a key at https://openrouter.ai/keys.` |
| `USE_GEMINI_IMAGES=true` AND `GEMINI_API_KEY` empty | `[config] USE_GEMINI_IMAGES=true but GEMINI_API_KEY is empty. Get a key at https://aistudio.google.com/app/api-keys.` |
| `USE_GEMINI_NARRATION=true` AND `GEMINI_API_KEY` empty | Same shape, swap variable name |

No live provider probes at startup. Reachability is left to the existing per-call error paths. Probes belong with Phase 2 (workers will perform them as part of their own lifecycle).

## What gets removed from the codebase

### Env variables that go away entirely
- `LOCAL_MODEL` (bare default)
- `OPENROUTER_MODEL` (bare default)
- `OPENROUTER_NARRATOR_MODEL`, `OPENROUTER_INTERPRETER_MODEL`, `OPENROUTER_ARCHIVIST_MODEL` (per-stage model envs — model now lives in the stage tuple)
- `LOCAL_NARRATOR_MODEL`, `LOCAL_ARCHIVIST_MODEL`, `LOCAL_INTERPRETER_MODEL` (same)
- `NARRATOR_GEMINI_MODEL`, `INTERPRETER_GEMINI_MODEL` (Gemini-text dies)
- `OPENROUTER_NARRATOR_THINKING`, `OPENROUTER_INTERPRETER_THINKING`, `OPENROUTER_ARCHIVIST_THINKING` (thinking knobs dropped — OpenRouter default rules)

### Code paths that go away
- Gemini text branches in `src/api.ts` — the `callGemini` chat path, the Gemini branches in `narratorTurn`/`interpreterTurn`, the `NARRATOR_GEMINI_MODEL` / `INTERPRETER_GEMINI_MODEL` constants, the validation case for `provider=gemini` on text stages.
- The `Provider = "gemini"` value as a valid text-stage option (remains in TTS/image code paths since those still use Gemini under the hood — but no longer as a `Provider` enum value for stages).
- `openRouterThinking()` and all reads of `OPENROUTER_<STAGE>_THINKING` env vars.

### What stays as hidden overrides (read by `config.ts`, omitted from `.env-sample`)
- `LOCAL_NARRATOR_TEMP`, `LOCAL_ARCHIVIST_TEMP`, `LOCAL_INTERPRETER_TEMP`
- `LOCAL_NARRATOR_TOP_P`, `LOCAL_ARCHIVIST_TOP_P`, `LOCAL_INTERPRETER_TOP_P`

### What stays unchanged
- `LM_STUDIO_URL`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`
- `SNAPSHOT_FIXTURES` (test-only, read in `src/engine.ts`, out of scope)
- TTS-related env reads in `gemini-tts.ts` (just the `GEMINI_API_KEY` lookup, already minimal)
- Image-related env reads in `gemini-image.ts` (same)

### Import-site changes (call out for the implementer)
- `src/server.ts` currently imports `validateApiConfig` from `./api`. The function relocates into `loadConfig()` in `src/config.ts` and `server.ts` calls `loadConfig()` instead. The `validateApiConfig` export from `api.ts` is removed.
- `src/api.ts` stops reading `process.env` for any of the migrated variables. Provider-dispatch functions inside `api.ts` receive a `Config` (or the relevant `StageConfig` slice) instead of reaching for env directly. The decision about whether `api.ts` accepts a `Config` once at module load vs. has functions take it as a parameter is left to the implementation plan.

## Frontend behavior changes

Gating the existing UI surfaces by the new flags:

- `USE_GEMINI_IMAGES=false` → the `/api/image` endpoint returns 503 with a clear body. The frontend's `geminiUnavailable` sticky-bit is set on first 503. The "images on/off" action-bar button stays visible but is disabled (greyed out, click is a no-op) so the affordance is discoverable but inert.
- `USE_GEMINI_NARRATION=false` → `/api/voices` returns 503. The "voice on/off" action-bar button is similarly disabled. The server's WebSocket handler does not emit `audio-*` messages even if a client requests narration (defense-in-depth in case the frontend's disabled state is bypassed).

(These changes are small. They live in `src/server.ts` route handlers and a couple of `src/web/app.tsx` capability checks. The audio playback controller and TTS engine code do NOT change in Phase 1.)

## Testing

New file `src/config.test.ts` (server-side, lives next to `api.ts`). Uses `bun:test`. Each test sets `process.env` values in a `beforeEach` that clears every known env var the new config reads — without this isolation, tests inherit live `.env` values and leak state into each other (a pattern bitten the project before).

Coverage:

1. Happy path: a fully valid config parses into the expected `Config` object.
2. Each malformed-input scenario produces the exact error message and exits.
3. Hidden tuning overrides parse correctly when present, `undefined` when absent or unparseable.
4. Bracket syntax `[openrouter, model]` parses identically to unbracketed.
5. `USE_GEMINI_*` strict booleanization — `"true"` works, `"1"` and `"yes"` do not.
6. Multi-error reporting: a config with 3 bad fields surfaces 3 errors before exit.

Existing tests in `src/api.test.ts` and `src/server.test.ts` get updated to set env vars in the new shape (no behavior change for those tests, just adjustment to the new keys).

## README updates

The Configuration section of `README.md` gets rewritten to reference the new shape. Specifically:

- The `.env` block in the README mirrors the new `.env-sample`.
- The "If you don't have or can't run LM Studio, you can enable these and do everything with Gemini" paragraph is removed (Gemini-as-narrator no longer exists).
- Add a one-paragraph note that the OpenRouter free Nemotron tier is the lowest-effort path to a working game without local models.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| User updates the code but doesn't update their `.env` → server fails to start | Error messages explicitly cite the new format with examples. Migration is a one-time cost. |
| Hidden overrides surprise debuggers later | A comment block in `config.ts` documents them, and the README mentions "advanced tuning overrides exist; see `src/config.ts`." |
| Tests for downstream code (`api.test.ts`) might break in subtle ways during env-key migration | Catch via the test suite; spec includes explicit step for updating those tests. |
| Phase 2 might want a different `Config` shape | Acceptable — `config.ts` is internal. Phase 2 can refactor freely. |

## Out of scope explicitly

- LLM dispatcher / per-provider workers
- Startup reachability probes
- Web UI config screen
- Connection-pool tuning beyond Bun defaults
- Voice / image-style env-configurability (those stay UI-driven runtime choices)
