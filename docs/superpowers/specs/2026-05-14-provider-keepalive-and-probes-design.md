# Provider Keep-Alive & Startup Probes — Design Spec

**Date:** 2026-05-14
**Status:** Approved, ready for implementation plan
**Phase:** 2 of 2 (Phase 1 = `.env` reorg, see `2026-05-13-env-reorg-design.md`)

## Goal

Eliminate per-call cold-start latency on LLM stages and surface configuration failures (LM Studio not running, wrong model loaded, bad API key, missing OpenRouter credits) at server startup instead of mid-turn. Both wins come from one mechanism: at startup, send a 1-token chat completion to every unique `(provider, model)` tuple in the config; on success, keep the connection warm with a periodic ping; on any failure, exit with a stage-aware error message before `Bun.serve()` is called.

## Non-goals

- TTS provider probing. The Chatterbox sidecar already has `waitForSidecarReady()`. ElevenLabs is a single user-triggered call per turn — cold-start is tolerable.
- Image probing (Gemini Nano Banana). User-triggered, infrequent, tolerates cold start.
- Snapshot exposure of probe state to the web UI. Not needed under fail-fast: by the time clients connect, every stage is healthy.
- Backoff, circuit-breaker, or "N consecutive failures → crash" runtime semantics. Runtime ping failures log and continue.
- Per-provider worker processes / IPC. The original Phase-2 framing in the env-reorg spec mentioned "LLM dispatcher / per-provider workers"; we picked in-process keep-alive instead because it's ~150 lines vs a second crash surface.

## Architecture

One new file: `src/prober.ts`. Exports two public functions plus one pure helper for testability.

`src/server.ts` calls the prober twice in `main()`:

1. `await probeProvidersAtStartup(serverConfig)` — after `loadConfig()` + `logStartupRouting()`, before sidecar/preset/serve. Throws on any failure; the catch in `main()` logs and `process.exit(1)`s.
2. `startKeepAlivePings(serverConfig)` — after `Bun.serve()` returns. Fire-and-forget interval.

The existing `warmupOpenRouter()` in `src/api.ts:68` is **deleted entirely**, along with its WS-open call site in `src/server.ts`. Its job is now the prober's responsibility, applied uniformly to every stage rather than only the narrator.

The prober knows about HTTP, provider URLs, and auth headers (the same shape `src/api.ts` already uses). It does not know about pipeline stages beyond reading `config.narrator/.archivist/.interpreter` to build its target list. It does not import from `api.ts` — both modules call `fetch` directly so neither owns the other.

## Module shape

```typescript
// src/prober.ts

import type { Config, StageConfig } from "./config";

export type ProbeTarget = {
  provider: "local" | "openrouter";
  model: string;
  usedBy: string[];   // ["narrator"], ["archivist", "interpreter"], etc.
};

// Pure: dedup the three stages by (provider, model).
export function buildProbeTargets(config: Config): ProbeTarget[];

// Sends one 1-token chat completion per target in parallel.
// Throws an aggregated Error naming every failed tuple if any probe fails.
// On all-success, logs `[prober] all N providers ready (Mms)` and resolves.
export async function probeProvidersAtStartup(config: Config): Promise<void>;

// Starts a 60s setInterval that re-probes the same target list.
// Failures call console.warn but do not throw.
// The interval is .unref()'d so it doesn't keep Bun alive on shutdown.
// Returns the Timer so callers can clearInterval if needed (mainly for tests).
export function startKeepAlivePings(config: Config): Timer;
```

## Probe semantics

Each probe is a `POST` to `/v1/chat/completions` at the provider's URL — `https://openrouter.ai/api/v1/chat/completions` for OpenRouter, or `${config.lmStudioUrl}/v1/chat/completions` for local. Body:

```json
{
  "model": "<target.model>",
  "messages": [{ "role": "user", "content": "ping" }],
  "max_tokens": 1
}
```

Identical to today's `warmupOpenRouter()` but applied per target. Headers match what `api.ts` already sends:

- **OpenRouter:** `Authorization: Bearer <OPENROUTER_API_KEY>`, plus the existing `HTTP-Referer` and `X-Title` attribution headers.
- **Local (LM Studio):** `Content-Type: application/json`, no auth.

A probe is **successful** if `res.ok` (HTTP 2xx). The response body is discarded — we don't care what the model says, only that the round trip completed.

**Per-probe timeout:** 10s via `AbortController`. Long enough for OpenRouter cold-start + TLS, short enough that a dead host doesn't stall boot.

**Probe parallelism:** `Promise.allSettled` over the dedup'd target list. All probes fire concurrently; we aggregate results before deciding whether to throw.

## Deduplication rule

Targets are dedup'd by the key `${provider}|${model}`. Two stages on the same provider with the same model share one probe (and therefore one keep-alive connection). Two stages on the same provider with different models get two probes — model-load is per-model on LM Studio, and provider-edge routing on OpenRouter is also frequently per-model.

`usedBy` accumulates the stage names that share a target so the failure message can name them.

## Error messages

Each failed probe produces one human-readable line. The prober maps known failure modes to actionable hints; unknown errors fall through with the raw message.

```
[prober] FAIL openrouter,openai/gpt-4o-mini (used by: archivist, interpreter)
         → 401 Unauthorized: check OPENROUTER_API_KEY
[prober] FAIL local,gemma-3-12b (used by: narrator)
         → connect ECONNREFUSED 127.0.0.1:1234: is LM Studio running?
[prober] startup failed; exiting
```

Mapping table (initial, extensible):

| Detected condition | Hint |
|---|---|
| HTTP 401 / 403 | `check OPENROUTER_API_KEY` |
| HTTP 402 | `OpenRouter out of credits` |
| HTTP 404 (model missing on LM Studio) | `model "<X>" not loaded in LM Studio — load it via the UI or `lms load`` |
| HTTP 404 (model missing on OR) | `model "<X>" not found on OpenRouter — check the slug` |
| HTTP 429 | `rate-limited at startup — try again` |
| `ECONNREFUSED` | `connect refused at <url>: is LM Studio running?` |
| `AbortError` (timeout) | `timeout after 10s` |
| anything else | raw `error.message` |

The aggregated thrown error includes one entry per failed target so `main()` can log them all before `process.exit(1)`.

## Startup flow

```
bun start
├── loadConfig()                                  [Phase 1]
├── logStartupRouting()                           [existing]
├── await probeProvidersAtStartup(config)         [NEW — exits on failure]
│   ├── buildProbeTargets(config) → [N unique]
│   ├── Promise.allSettled([N parallel probes])
│   └── on any rejection: throw aggregated error
├── if (useNarration && !useElevenLabs) spawnSidecar()  [existing]
├── presets = await loadAllPresets()              [existing]
├── currentStack = await loadStack()              [existing]
├── const server = Bun.serve({ ... })             [existing]
├── startKeepAlivePings(config)                   [NEW — fire & forget]
└── waitForSidecarReady().then(...)               [existing]
```

The probe runs **after** config logging so the user can see the resolved provider/model lines first, then either "ready" or the failure list.

## Runtime keep-alive

`startKeepAlivePings` does:

```typescript
const targets = buildProbeTargets(config);
const timer = setInterval(async () => {
  const results = await Promise.allSettled(targets.map(t => probeOne(t, 10_000)));
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "rejected") {
      console.warn(`[prober] keep-alive failed: ${targets[i].provider},${targets[i].model} — ${results[i].reason}`);
    }
  }
}, 60_000);
timer.unref();
return timer;
```

**Cadence:** 60 seconds. Aggressive enough to keep typical TLS keep-alive windows open (OpenRouter and most edges hold idle connections 60-90s); slow enough to be invisible in the log under normal operation.

**Failure semantics:** log via `console.warn`, no throw, no state change. The next real LLM call may also fail and surface to the player as a turn error — that's acceptable. The player can recover; a server crash mid-session loses the active session.

**Concurrency:** ticks share the underlying `fetch` connection pool with real LLM traffic. No locks, no dedup against in-flight calls. Bun's pool handles it.

## Deletions

From `src/api.ts`:
- `warmupOpenRouter()` (lines 68-97) — superseded by `probeProvidersAtStartup`.

From `src/server.ts`:
- `import { warmupOpenRouter, ... } from "./api";` — narrow to `import { logStartupRouting } from "./api";`.
- The fire-and-forget `warmupOpenRouter().catch(() => {});` in the WS open handler (around line 430-431).

## Testing

`src/prober.test.ts`, mirroring the patterns in `src/config.test.ts` and `src/api.test.ts`:

**`buildProbeTargets` (pure, no mocking needed):**
- All three stages on the same `(provider, model)` → 1 target with `usedBy = ["narrator", "archivist", "interpreter"]`.
- All three stages on different providers/models → 3 targets.
- Two stages share, one differs → 2 targets, the shared one with two `usedBy` entries.
- Same provider, different models → 2 targets (deduplication is on `(provider, model)`, not `provider` alone).

**`probeProvidersAtStartup` (stubs `globalThis.fetch`, restores in `afterEach`):**
- All probes 200 → resolves silently.
- One probe 401 → throws an Error whose message contains the failed tuple and the auth hint.
- All probes fail with different errors → throws an aggregated error naming every tuple.
- Probe times out (`AbortError`) → throws with the timeout hint.
- Verifies parallelism: stub `fetch` to record call timestamps; assert all calls fire within a few ms of each other rather than serially.

**`startKeepAlivePings` (fake timer + stubbed fetch):**
- Returns a Timer that, when its interval fires, calls `fetch` once per unique target.
- A failed probe results in a `console.warn` call but does not throw and does not stop the interval.
- `clearInterval` on the returned Timer stops further ticks.

**Integration / smoke:** none. The probe is exercised every time `bun start` runs; if it breaks, the server won't boot.

## Verification command

`bun test && bunx tsc --noEmit` after each commit.

## Out of scope (future, not Phase 3)

- TTS / image probing — covered above.
- UI exposure of probe results — fail-fast makes this redundant.
- Adaptive cadence (slow down pings when LLM traffic is hot, speed up when idle).
- Probe budget / throttling for paid providers — 1 token every 60s is ~$0.0001/hour at GPT-4o-mini rates, well under noise.
