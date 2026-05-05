import { Channel } from "../platform/channel.ts";
import {
  TraderProfile,
  type TraderNodeData,
  type TraderPersonaBlock,
} from "../platform/config/trader-info.ts";
import { ActionType, DEFAULT_TRADER_ACTIONS } from "../platform/typing.ts";
import { TradingAgent, type ModelInput } from "./agent.ts";
import { TraderGraph } from "./agent-graph.ts";

export interface GenerateTradersOptions {
  /** Pre-built profiles. If omitted, `count` archetypes are generated. */
  profiles?: TraderNodeData[];
  /** When `profiles` is omitted, build N traders from the cycling archetype list. */
  count?: number;
  /** Mastra-compatible model. Required only if traders will run LLM actions. */
  model?: ModelInput;
  /** Overrides default action set. */
  availableActions?: ActionType[];
  /** Pre-built channel. Otherwise a fresh one is created (re-bound by env.reset). */
  channel?: Channel;
  /** Optional override for the system prompt template. */
  systemTemplate?: string;
}

export const ARCHETYPES: Array<{
  persona: TraderPersonaBlock;
  handle: string;
  cash: number;
  pos: number;
}> = [
  {
    handle: "momentum_max",
    cash: 10_000,
    pos: 0,
    persona: {
      style: "momentum",
      riskTolerance: "high",
      horizon: "intraday",
      bias: "neutral",
      thesis: "Buy strength, sell weakness. Trend continuation in the absence of news.",
      beliefs: ["Recent winners keep winning over short horizons", "Cut losers fast"],
    },
  },
  {
    handle: "value_vera",
    cash: 10_000,
    pos: 0,
    persona: {
      style: "mean-reversion",
      riskTolerance: "low",
      horizon: "swing",
      bias: "neutral",
      thesis: "Fade dislocations from a slow moving average. Patience over urgency.",
      beliefs: ["Prices revert to fair value", "Avoid chasing"],
    },
  },
  {
    handle: "contra_carl",
    cash: 10_000,
    pos: 0,
    persona: {
      style: "contrarian",
      riskTolerance: "medium",
      horizon: "swing",
      bias: "bear",
      thesis: "Sell into euphoria, buy capitulation. Anti-momentum on overextensions.",
      beliefs: ["Crowds are usually wrong at extremes"],
    },
  },
  {
    handle: "market_maker_mira",
    cash: 20_000,
    pos: 0,
    persona: {
      style: "market-making",
      riskTolerance: "low",
      horizon: "scalp",
      bias: "neutral",
      thesis: "Quote both sides around mark to capture spread. Keep inventory near zero.",
      beliefs: ["Pay taker only when forced", "Edge comes from spread, not direction"],
    },
  },
  {
    handle: "noise_nora",
    cash: 5_000,
    pos: 0,
    persona: {
      style: "noise",
      riskTolerance: "high",
      horizon: "scalp",
      bias: "neutral",
      thesis: "Trade on impulse. Sometimes right, often wrong. Provides liquidity.",
      beliefs: ["Variance is opportunity"],
    },
  },
];

/**
 * Build a `TraderGraph` populated with `count` archetype traders, or with the
 * given `profiles`. Convenience factory for quickly assembling a multi-persona
 * sim without hand-wiring each trader.
 */
export function generateTraderGraph(opts: GenerateTradersOptions): TraderGraph {
  const channel = opts.channel ?? new Channel();
  const graph = new TraderGraph();
  const actions = opts.availableActions ?? DEFAULT_TRADER_ACTIONS;
  const profiles = opts.profiles ?? defaultProfiles(opts.count ?? 4);

  for (let i = 0; i < profiles.length; i++) {
    const node = profiles[i]!;
    const profile = TraderProfile.fromNode(node);
    const agentId = Number(node.trader_id ?? node.trader_index ?? i);
    const agent = new TradingAgent({
      agentId,
      profile,
      model: opts.model,
      channel,
      availableActions: actions,
      systemTemplate: opts.systemTemplate,
    });
    graph.addAgent(agent);
  }
  return graph;
}

function defaultProfiles(n: number): TraderNodeData[] {
  const out: TraderNodeData[] = [];
  for (let i = 0; i < n; i++) {
    const arche = ARCHETYPES[i % ARCHETYPES.length]!;
    out.push({
      trader_id: i,
      handle: `${arche.handle}_${i}`,
      display_name: arche.handle,
      initial_cash: arche.cash,
      initial_position: arche.pos,
      persona: arche.persona,
    });
  }
  return out;
}

/**
 * Re-bind every trader in the graph to a shared `Channel`, then call
 * `OPEN_ACCOUNT` on each via that channel. Invoked by `SealionEnv.reset()`.
 */
export async function openAllAccounts(graph: TraderGraph, channel: Channel): Promise<TraderGraph> {
  const traders = graph.getAgents();
  for (const [, agent] of traders) agent.setChannel(channel);
  await Promise.all(traders.map(([, a]) => a.openAccount()));
  return graph;
}
