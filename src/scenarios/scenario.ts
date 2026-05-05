import { existsSync, unlinkSync } from "node:fs";
import { LLMAction, ManualAction } from "../environment/env-action.ts";
import { SealionEnv, type StepContext } from "../environment/env.ts";
import { computeMetrics, type Metrics } from "../metrics.ts";
import { MarketMakerBot } from "../trading-agent/market-maker-bot.ts";
import type { TradingAgent } from "../trading-agent/agent.ts";
import { TraderGraph } from "../trading-agent/agent-graph.ts";
import type { PriceSimulator } from "../platform/pricer.ts";
import type { MarketSpec, RiskConfig } from "../platform/typing.ts";

export type DecideAction = (
  agent: TradingAgent,
  ctx: StepContext,
) => ManualAction | LLMAction | Array<ManualAction | LLMAction> | null | undefined;

export interface ScenarioOptions {
  /** Market spec (use a preset or `customMarket`). */
  market: MarketSpec;
  /** Where the SQLite db lives. */
  databasePath: string;
  /** All participating traders. */
  traders: TraderGraph;
  /** Optional price simulator that drives mark price. */
  pricer?: PriceSimulator;
  /** Initial price tick. Falls back to first pricer tick if not provided. */
  initialPrice?: number;
  /**
   * Decision policy. Called for each agent each step. Return null/undefined
   * to skip the agent on that step. `MarketMakerBot` instances are auto-driven
   * via `bot.quote(mark)` if no decision is provided.
   */
  decideAction?: DecideAction;
  /**
   * Per-agent risk config. Frozen agents stay frozen for the rest of the run.
   */
  risk?: Map<number, RiskConfig>;
  /**
   * Number of steps to run. If a pricer signals exhaustion (via `hasNext()`
   * returning false), the run ends earlier.
   */
  steps: number;
  /** Steps to run pricer-only before any agent acts. Default 0. */
  warmupSteps?: number;
  /** Remove the existing db file before running. Default false. */
  fresh?: boolean;
  /** Hook called after each step (e.g. for logging or stop conditions). */
  onStep?: (ctx: StepContext) => void | Promise<void>;
  /** Stop the run early if this returns true. */
  stopWhen?: (ctx: StepContext) => boolean;
}

export interface ScenarioResult {
  steps: number;
  metrics: Map<number, Metrics>;
  accounts: Array<{
    agentId: number;
    handle: string | null;
    cash: number;
    position: number;
    realizedPnl: number;
    feesPaid: number;
    equity: number;
    frozen: boolean;
  }>;
  /** The env (still open if you want to inspect; the harness closes it for you). */
  env: SealionEnv;
}

/**
 * High-level orchestrator: bundles a market, agents, a price simulator, and a
 * decision policy into a single runnable simulation. Use this whenever you'd
 * otherwise hand-write `env.reset() + for-loop + env.close()`.
 *
 * Subsumes the older `Backtest` (which is now a thin wrapper).
 *
 * @example Position-only sim (no trading, just watch P&L of a starting position):
 * ```ts
 * const sc = new Scenario({
 *   market: spotPreset({ symbol: "BTC/USDT" }),
 *   databasePath: "./data/pos.db",
 *   registry,
 *   pricer: new GBM({ start: 50_000, mu: 0, sigma: 0.02 }),
 *   steps: 100,
 * });
 * await sc.run();
 * ```
 *
 * @example Multi-agent rule-based with auto-quoting MM:
 * ```ts
 * const sc = new Scenario({
 *   market: spotPreset({ symbol: "BTC/USDT" }),
 *   databasePath: "./data/sim.db",
 *   registry,
 *   pricer: new RandomWalk({ start: 100, sigma: 0.5 }),
 *   steps: 50,
 *   decideAction: (agent, ctx) => myStrategy(agent, ctx),
 * });
 * ```
 */
export class Scenario {
  constructor(private opts: ScenarioOptions) {}

  async run(): Promise<ScenarioResult> {
    const opts = this.opts;
    if (opts.fresh && existsSync(opts.databasePath)) {
      try {
        unlinkSync(opts.databasePath);
      } catch {
        // Windows lock — fine to ignore.
      }
    }

    // Resolve initial price from pricer if not given.
    let initialPrice = opts.initialPrice;
    if (initialPrice === undefined && opts.pricer) {
      // Don't consume the pricer's first tick — peek isn't required by the
      // interface. Fall back to leaving Exchange to compute mark from book.
    }

    const env = new SealionEnv({
      traders: opts.traders,
      market: opts.market,
      databasePath: opts.databasePath,
      pricer: opts.pricer,
      initialPrice,
      risk: opts.risk,
    });
    await env.reset();

    // Warmup ticks (no agent actions).
    for (let i = 0; i < (opts.warmupSteps ?? 0); i++) {
      env.tickPricer();
      if (opts.pricer && opts.pricer.hasNext && !opts.pricer.hasNext()) break;
    }

    const startingByAgent = new Map<number, { cash: number; position: number }>();
    for (const [aid, agent] of opts.traders.getAgents()) {
      startingByAgent.set(aid, {
        cash: agent.profile.initialCash,
        position: agent.profile.initialPosition,
      });
    }

    let stepsRun = 0;
    for (let step = 0; step < opts.steps; step++) {
      // Stop early if the pricer is exhausted.
      if (opts.pricer && opts.pricer.hasNext && !opts.pricer.hasNext()) break;

      const turn = new Map<
        TradingAgent,
        ManualAction | LLMAction | Array<ManualAction | LLMAction>
      >();
      const mark = env.exchange.markPrice();

      for (const [, agent] of opts.traders.getAgents()) {
        // 1. User-supplied decision wins.
        if (opts.decideAction) {
          const action = opts.decideAction(agent, { step, mark, pricerTick: null });
          if (action) {
            turn.set(agent, action);
            continue;
          }
        }
        // 2. Auto-quote any MarketMakerBot.
        if (agent instanceof MarketMakerBot) {
          const quoteActions = agent.quote(mark);
          if (quoteActions.length > 0) turn.set(agent, quoteActions);
        }
      }

      const ctx = await env.step(turn);
      stepsRun = step + 1;

      if (opts.onStep) await opts.onStep(ctx);
      if (opts.stopWhen?.(ctx)) break;
    }

    await env.close();

    const metrics = new Map<number, Metrics>();
    const accounts: ScenarioResult["accounts"] = [];
    for (const [aid] of opts.traders.getAgents()) {
      const start = startingByAgent.get(aid) ?? { cash: 0, position: 0 };
      const m = computeMetrics(env.exchange.db, aid, start.cash, {
        startingPosition: start.position,
      });
      metrics.set(aid, m);
      const snap = env.exchange.snapshot(aid);
      if (!snap) continue;
      accounts.push({
        agentId: snap.agentId,
        handle: snap.handle,
        cash: snap.cash,
        position: snap.position,
        realizedPnl: snap.realizedPnl,
        feesPaid: snap.feesPaid,
        equity: snap.equity,
        frozen: snap.frozen,
      });
    }

    return { steps: stepsRun, metrics, accounts, env };
  }
}
