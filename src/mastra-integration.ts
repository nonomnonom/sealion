import type { Agent } from "@mastra/core/agent";
import type { TraderGraph } from "./trading-agent/agent-graph.ts";

/**
 * Marker type for a Mastra instance — typed loosely so users can instantiate
 * `Mastra` from any compatible `@mastra/core` version without our types
 * pinning their version. Use the concrete `Mastra` class from `@mastra/core`
 * at construction time.
 */
export interface MastraLike {
  setAgents?(agents: Record<string, Agent>): void;
}

/**
 * Pull every trader's underlying Mastra `Agent` into a `Record` so it can be
 * spread into `new Mastra({ agents: { ... } })`. Useful when you want Studio
 * observability, scorer attachment, or workflow integration for your traders.
 *
 * Lazy-constructs each agent's underlying Mastra `Agent`, so it requires every
 * `TradingAgent` to have a `model` configured. Traders without a model are
 * skipped with a console warning.
 */
export function collectMastraAgents(traders: TraderGraph): Record<string, Agent> {
  const out: Record<string, Agent> = {};
  for (const [, trader] of traders.getAgents()) {
    try {
      out[`trader-${trader.agentId}`] = trader.agent;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[sealion] skipping trader ${trader.agentId}: ${msg}`);
    }
  }
  return out;
}

/**
 * Add every trader's `Agent` to an existing Mastra instance. Mastra agents
 * registered after construction is supported via `mastra.setAgents(...)` in
 * recent versions; the recommended pattern remains passing `agents:
 * collectMastraAgents(traders)` at construction time.
 */
export function registerWithMastra(
  mastra: MastraLike,
  traders: TraderGraph,
): Record<string, Agent> {
  const agents = collectMastraAgents(traders);
  if (typeof mastra.setAgents === "function") {
    mastra.setAgents(agents);
  }
  return agents;
}

/**
 * Best-practice Mastra `Observability` config for Sealion sims.
 * Returns a plain object the user spreads into `new Mastra({ observability: ... })`.
 *
 * @example
 * ```ts
 * import { Mastra } from "@mastra/core";
 * import { Observability, DefaultExporter, SensitiveDataFilter } from "@mastra/observability";
 * import { collectMastraAgents, sealionObservabilityConfig } from "@nonomnonom/sealion";
 *
 * const obs = new Observability(sealionObservabilityConfig({
 *   exporters: [new DefaultExporter()],
 *   redact: [new SensitiveDataFilter()],
 * }));
 *
 * const mastra = new Mastra({
 *   agents: collectMastraAgents(traders),
 *   observability: obs,
 * });
 * ```
 *
 * Returns the `configs` shape Mastra's `Observability` constructor expects.
 * Users can override per-field by spreading their own config on top.
 */
export function sealionObservabilityConfig(opts: {
  serviceName?: string;
  exporters?: unknown[];
  redact?: unknown[];
}): {
  configs: {
    default: {
      serviceName: string;
      exporters: unknown[];
      spanOutputProcessors: unknown[];
    };
  };
} {
  return {
    configs: {
      default: {
        serviceName: opts.serviceName ?? "sealion",
        exporters: opts.exporters ?? [],
        spanOutputProcessors: opts.redact ?? [],
      },
    },
  };
}
