// Sealion — multi-agent market simulation framework on Mastra + bun:sqlite.
//
// Pick any model provider: `model: "openai/gpt-4o-mini"`, `"anthropic/claude-..."`,
// `"google/..."`, `"groq/..."`, `"deepseek/..."` — all routed through Mastra.

// ── Environment / lifecycle ──────────────────────────────────────────────────

export { ManualAction, LLMAction, type AnyAction } from "./environment/env-action.ts";

export { make } from "./environment/make.ts";
export {
  SealionEnv,
  type SealionEnvOptions,
  type StepActions,
  type StepContext,
} from "./environment/env.ts";

// ── Traders ──────────────────────────────────────────────────────────────────

export {
  generateTraderGraph,
  openAllAccounts,
  ARCHETYPES,
  type GenerateTradersOptions,
} from "./trading-agent/agents-generator.ts";

export { TradingAgent, type TradingAgentOptions } from "./trading-agent/agent.ts";

export { TraderGraph } from "./trading-agent/agent-graph.ts";

export {
  TraderProfile,
  DEFAULT_TEMPLATE,
  type TraderNodeData,
  type TraderPersonaBlock,
} from "./platform/config/trader-info.ts";

// ── Exchange / platform ──────────────────────────────────────────────────────

export { Exchange, type ExchangeOptions } from "./platform/platform.ts";

export {
  ActionType,
  OrderSide,
  OrderType,
  OrderStatus,
  DefaultMarketType,
  DEFAULT_TRADER_ACTIONS,
  SOCIAL_TRADER_ACTIONS,
  SOCIAL_PLUS_TRADING_ACTIONS,
  type MarketSpec,
  type RiskConfig,
  type ActionResult,
  type ChannelMessage,
  type ChannelResponse,
} from "./platform/typing.ts";

export { printDbContents } from "./testing/show-db.ts";

// ── Markets, pricers, scenarios ──────────────────────────────────────────────

// Markets — pluggable specs (no global default; explicit at the call site)
export { spotPreset, perpPreset, equityPreset, customMarket } from "./markets/presets.ts";

// Pricers — pluggable price processes (the "recsys" of trading)
export {
  type PriceSimulator,
  type PriceTick,
  ConstantPrice,
  RandomWalk,
  GBM,
  MeanReversion,
  Replay,
  JumpDiffusion,
  Composite,
  Scripted,
  type ConstantPriceOptions,
  type RandomWalkOptions,
  type GBMOptions,
  type MeanReversionOptions,
  type ReplayOptions,
  type JumpDiffusionOptions,
  type ScriptedOptions,
  type ScriptedShock,
} from "./platform/pricer.ts";

// Scenarios — high-level orchestrator
export {
  Scenario,
  type ScenarioOptions,
  type ScenarioResult,
  type DecideAction,
} from "./scenarios/scenario.ts";

// MarketMakerBot — rule-based auto-quoting agent (extends TradingAgent)
export {
  MarketMakerBot,
  makeMarketMaker,
  type MarketMakerOptions,
} from "./trading-agent/market-maker-bot.ts";

// MarketEnvironment — text-prompt builder for an agent's view
export { MarketEnvironment, type MarketSnapshot } from "./trading-agent/agent-environment.ts";

// Channel + Clock
export { Channel } from "./platform/channel.ts";
export { SandboxClock } from "./clock/clock.ts";

// Tool factory (for users adding custom tools)
export { ALL_TOOL_ACTIONS, buildAgentTools } from "./trading-agent/agent-action.ts";

// Read-only action set (skipped by trace logger — exposed for user inspection)
export { READ_ONLY_ACTIONS } from "./platform/typing.ts";

// Matching engine internals (for users who want to peek)
export {
  MatchingEngine,
  type MatchResult,
  type MatchedTrade,
  type SubmitOrderInput,
} from "./platform/matching-engine.ts";

// Database / persistence
export {
  openDatabase,
  SCHEMA_SQL,
  type AccountRow,
  type OrderRow,
  type TradeRow,
  type TickRow,
  type CopyTradeEdgeRow,
  type SignalRow,
  getCopyTradeEdges,
  insertCopyTradeEdge,
  deactivateCopyTradeEdge,
  getSignals,
  insertSignal,
} from "./platform/database.ts";

// Metrics
export { computeMetrics, type EquityPoint, type Metrics } from "./metrics.ts";

// Shared utilities
export { safeNumber, safeStringify, applyFillToPosition, type PositionState } from "./utils.ts";

// ── Mastra-integration helpers ───────────────────────────────────────────────

export {
  collectMastraAgents,
  registerWithMastra,
  sealionObservabilityConfig,
  type MastraLike,
} from "./mastra-integration.ts";

// Built-in scorers for trading evals
export {
  createPnLScorer,
  createPersonaConsistencyScorer,
  type PnLScorerOptions,
} from "./evals/scorers.ts";
