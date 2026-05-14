import type { Config, Provider } from "./config";

export type ProbeTarget = {
  provider: Provider;
  model: string;
  usedBy: string[];   // stage names that share this (provider, model) tuple
};

const STAGE_ORDER = ["narrator", "archivist", "interpreter"] as const;

/**
 * Dedup the three pipeline stages into the unique (provider, model) tuples
 * that need to be probed. Stages that share a tuple share a probe — and
 * therefore share a keep-alive connection.
 */
export function buildProbeTargets(config: Config): ProbeTarget[] {
  const byKey = new Map<string, ProbeTarget>();
  for (const stage of STAGE_ORDER) {
    const sc = config[stage];
    const key = `${sc.provider}|${sc.model}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.usedBy.push(stage);
    } else {
      byKey.set(key, { provider: sc.provider, model: sc.model, usedBy: [stage] });
    }
  }
  return Array.from(byKey.values());
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const PROBE_TIMEOUT_MS = 10_000;

class ProbeHttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Map a probe failure (HTTP status code, fetch error) to a human-readable
 * actionable hint. Returns the hint string; the caller composes the full
 * "[prober] FAIL ..." line.
 */
function explainFailure(target: ProbeTarget, err: unknown): string {
  if (err instanceof ProbeHttpError) {
    const code = err.status;
    if (code === 401 || code === 403) {
      return target.provider === "openrouter"
        ? "check OPENROUTER_API_KEY"
        : `HTTP ${code}: local endpoint returned Unauthorized`;
    }
    if (code === 402) return "OpenRouter out of credits";
    if (code === 404) {
      return target.provider === "local"
        ? `model "${target.model}" not loaded in LM Studio — load it via the UI or \`lms load\``
        : `model "${target.model}" not found on OpenRouter — check the slug`;
    }
    if (code === 429) return "rate-limited at startup — try again";
    return `HTTP ${code}: ${err.body.slice(0, 200)}`;
  }
  if (err instanceof Error) {
    if (err.name === "AbortError") return `timeout after ${PROBE_TIMEOUT_MS / 1000}s`;
    // Bun surfaces ECONNREFUSED as TypeError("fetch failed"); the cause has
    // the underlying code. Match on either the message or the cause.
    const msg = err.message.toLowerCase();
    const cause = (err as { cause?: { code?: string } }).cause;
    if (msg.includes("econnrefused") || cause?.code === "ECONNREFUSED" || msg === "fetch failed") {
      return target.provider === "local"
        ? `connect refused: is LM Studio running?`
        : `connect refused: is the network up?`;
    }
    return err.message;
  }
  return String(err);
}

/**
 * Send one 1-token chat completion. Throws ProbeHttpError on non-2xx,
 * AbortError on timeout, or the raw error on network failure.
 */
async function probeOne(
  target: ProbeTarget,
  lmStudioUrl: string,
  openRouterApiKey: string | null,
): Promise<void> {
  const url =
    target.provider === "openrouter"
      ? OPENROUTER_URL
      : `${lmStudioUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (target.provider === "openrouter") {
    if (!openRouterApiKey) throw new Error("OPENROUTER_API_KEY not set");
    headers["Authorization"] = `Bearer ${openRouterApiKey}`;
    headers["HTTP-Referer"] = "https://github.com/hazlema/World-Engine-LLM";
    headers["X-Title"] = "World Engine LLM";
  }
  const body = JSON.stringify({
    model: target.model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProbeHttpError(res.status, text);
    }
    // Discard body — we only care that the round trip completed.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe every unique (provider, model) tuple in parallel. On any failure,
 * throw an aggregated Error whose message names every failed tuple with an
 * actionable hint. On all-success, log "[prober] all N providers ready (Mms)"
 * and resolve.
 */
export async function probeProvidersAtStartup(config: Config): Promise<void> {
  const targets = buildProbeTargets(config);
  const start = Date.now();
  const results = await Promise.allSettled(
    targets.map(t => probeOne(t, config.lmStudioUrl, config.openRouterApiKey)),
  );
  const failures: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "rejected") {
      const t = targets[i]!;
      const hint = explainFailure(t, (r as PromiseRejectedResult).reason);
      failures.push(
        `  ${t.provider},${t.model} (used by: ${t.usedBy.join(", ")})\n    → ${hint}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `[prober] ${failures.length} provider(s) failed startup probe:\n${failures.join("\n")}`,
    );
  }
  console.log(`[prober] all ${targets.length} provider(s) ready (${Date.now() - start}ms)`);
}

const DEFAULT_KEEPALIVE_MS = 60_000;

/**
 * Per-tick keep-alive logic, extracted so tests can call it directly without
 * timer mocking. Re-probes every target in parallel; failures call
 * console.warn but do not throw.
 */
export async function runKeepAliveTick(
  targets: ProbeTarget[],
  lmStudioUrl: string,
  openRouterApiKey: string | null,
): Promise<void> {
  const results = await Promise.allSettled(
    targets.map(t => probeOne(t, lmStudioUrl, openRouterApiKey))
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "rejected") {
      const t = targets[i]!;
      const hint = explainFailure(t, (r as PromiseRejectedResult).reason);
      console.warn(`[prober] keep-alive failed: ${t.provider},${t.model} — ${hint}`);
    }
  }
}

/**
 * Start a 60s setInterval that runs runKeepAliveTick. Returns the Timer so
 * callers can clearInterval it (mainly for tests). The Timer is .unref()'d
 * so it doesn't keep Bun alive on shutdown.
 *
 * `intervalMs` defaults to 60_000; tests pass a small value to verify ticking.
 */
export function startKeepAlivePings(config: Config, intervalMs: number = DEFAULT_KEEPALIVE_MS): Timer {
  const targets = buildProbeTargets(config);
  const timer = setInterval(() => {
    runKeepAliveTick(targets, config.lmStudioUrl, config.openRouterApiKey);
  }, intervalMs);
  timer.unref();
  return timer;
}
