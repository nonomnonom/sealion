import { LLMAction, ManualAction } from "./env-action.ts";
import { openAllAccounts } from "../trading-agent/agents-generator.ts";
import { TraderGraph } from "../trading-agent/agent-graph.ts";
import type { TradingAgent } from "../trading-agent/agent.ts";
import { Channel } from "../platform/channel.ts";
import { Exchange } from "../platform/platform.ts";
import type { PriceSimulator, PriceTick } from "../platform/pricer.ts";
import { ActionType, type MarketSpec, type RiskConfig } from "../platform/typing.ts";

/**
 * Either pass a `MarketSpec` (Sealion will build the `Exchange` for you) —
 * typical usage — or pass a fully-constructed `Exchange` for full control.
 */
export interface SealionEnvOptions {
  /** Required. Trader graph holding all agents in the simulation. */
  traders: TraderGraph;
  /**
   * Use a preset (`spotPreset`, `perpPreset`, `equityPreset`, `customMarket`)
   * to build the spec — Sealion exposes no global default.
   */
  market?: MarketSpec;
  /** Pre-built Exchange. Mutually exclusive with `market` + `databasePath`. */
  exchange?: Exchange;
  /** Required when `market` is given. Path to the SQLite db. */
  databasePath?: string;
  /** Optional initial price tick written before any agent acts. */
  initialPrice?: number;
  /** Optional pluggable price process — invoked at the start of each step. */
  pricer?: PriceSimulator;
  /** Per-agent risk limits keyed by agentId. */
  risk?: Map<number, RiskConfig>;
  /** Max concurrent LLM `generate()` calls in flight. Default 64. */
  maxConcurrentLLM?: number;
}

export type StepActions = Map<
  TradingAgent,
  ManualAction | LLMAction | Array<ManualAction | LLMAction>
>;

export interface StepContext {
  step: number;
  mark: number | null;
  pricerTick: PriceTick | null;
}

class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];
  constructor(permits: number) {
    this.permits = permits;
  }
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.permits += 1;
  }
}

export class SealionEnv {
  traders: TraderGraph;
  exchange: Exchange;
  channel: Channel;
  pricer?: PriceSimulator;
  private llmSemaphore: Semaphore;
  private exchangeTask: Promise<void> | null = null;
  private stepCounter = 0;
  private closed = false;

  constructor(opts: SealionEnvOptions) {
    this.traders = opts.traders;
    this.pricer = opts.pricer;
    this.llmSemaphore = new Semaphore(opts.maxConcurrentLLM ?? 64);

    if (opts.exchange && opts.market) {
      throw new Error("`exchange` and `market` are mutually exclusive. Pass one or the other.");
    }
    if (opts.exchange && opts.databasePath) {
      throw new Error(
        "`exchange` and `databasePath` are mutually exclusive. The pre-built " +
          "Exchange already owns its database path.",
      );
    }

    if (opts.exchange) {
      this.exchange = opts.exchange;
      this.channel = opts.exchange.channel;
    } else {
      if (!opts.market) {
        throw new Error(
          "Either `exchange` or `market` is required. Use a preset like " +
            "`spotPreset({ symbol: 'BTC/USDT' })` to build a MarketSpec.",
        );
      }
      if (!opts.databasePath) {
        throw new Error("`databasePath` is required when `market` is given.");
      }
      this.channel = new Channel();
      this.exchange = new Exchange({
        dbPath: opts.databasePath,
        market: opts.market,
        channel: this.channel,
        initialPrice: opts.initialPrice,
      });
    }

    if (opts.risk) {
      for (const [aid, cfg] of opts.risk) this.exchange.setRiskConfig(aid, cfg);
    }
  }

  /** Start the exchange run-loop and open all trader accounts. */
  async reset(): Promise<void> {
    this.exchangeTask = this.exchange.runLoop();
    await openAllAccounts(this.traders, this.channel);
    this.stepCounter = 0;
  }

  /** Pull the next pricer tick (if configured) and inject it. */
  tickPricer(): PriceTick | null {
    if (!this.pricer) return null;
    const tick = this.pricer.next();
    if (tick) this.exchange.injectPrice(tick.price, tick.volume ?? 0);
    return tick;
  }

  async step(actions: StepActions): Promise<StepContext> {
    const pricerTick = this.tickPricer();
    const mark = this.exchange.markPrice();

    const tasks: Promise<unknown>[] = [];
    for (const [agent, action] of actions.entries()) {
      const list = Array.isArray(action) ? action : [action];
      for (const single of list) {
        if (single instanceof ManualAction) {
          tasks.push(agent.performActionByData(single.actionType, single.actionArgs));
        } else if (single instanceof LLMAction) {
          tasks.push(this.runLLM(agent));
        }
      }
    }
    await Promise.all(tasks);

    this.exchange.sandboxClock.advance();
    const ctx: StepContext = { step: this.stepCounter, mark, pricerTick };
    this.stepCounter += 1;
    return ctx;
  }

  private async runLLM(agent: TradingAgent): Promise<unknown> {
    await this.llmSemaphore.acquire();
    try {
      return await agent.performActionByLLM();
    } finally {
      this.llmSemaphore.release();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.channel.writeToReceiveQueue([null, null, ActionType.EXIT]);
    if (this.exchangeTask) await this.exchangeTask;
  }
}
