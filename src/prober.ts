import type { Config } from "./config";

export type ProbeTarget = {
  provider: "local" | "openrouter";
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
