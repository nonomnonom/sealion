import { ManualAction } from "../environment/env-action.ts";
import { TraderProfile } from "../platform/config/trader-info.ts";
import { ActionType, OrderSide } from "../platform/typing.ts";
import { TradingAgent, type TradingAgentOptions } from "./agent.ts";

export interface MarketMakerOptions extends Omit<
  TradingAgentOptions,
  "model" | "availableActions"
> {
  /** Spread in basis points around mark. e.g. 10 = ±5bps each side. */
  spreadBps?: number;
  /** Quote size on each side. */
  quoteSize?: number;
  /** Number of price levels per side. */
  levels?: number;
  /** Step between levels in basis points. */
  levelStepBps?: number;
}

/**
 * Pure rule-based agent that auto-quotes around the current mark price each
 * time `quote()` is called. Use it as a "noise market-maker" so simulated
 * markets always have liquidity. Doesn't need an LLM.
 *
 * @example
 * ```ts
 * const mm = new MarketMakerBot({
 *   agentId: 999,
 *   profile: new TraderProfile({ handle: "mm", initialCash: 1_000_000, initialPosition: 100 }),
 *   spreadBps: 20,
 *   quoteSize: 1,
 *   levels: 3,
 * });
 * traders.addAgent(mm);
 * // Each step:
 * await env.step(new Map([[mm, mm.quote(currentMark)]]));
 * ```
 */
export class MarketMakerBot extends TradingAgent {
  spreadBps: number;
  quoteSize: number;
  levels: number;
  levelStepBps: number;

  constructor(opts: MarketMakerOptions) {
    super({
      ...opts,
      availableActions: [ActionType.PLACE_LIMIT_ORDER, ActionType.CANCEL_ALL_ORDERS],
    });
    this.spreadBps = opts.spreadBps ?? 20;
    this.quoteSize = opts.quoteSize ?? 1;
    this.levels = Math.max(1, opts.levels ?? 1);
    this.levelStepBps = opts.levelStepBps ?? 10;
  }

  /** Return a list of actions: cancel-all + post bids/asks around `mark`. */
  quote(mark: number | null): ManualAction[] {
    if (mark === null || !Number.isFinite(mark) || mark <= 0) return [];
    const out: ManualAction[] = [
      new ManualAction({ actionType: ActionType.CANCEL_ALL_ORDERS, actionArgs: {} }),
    ];
    const halfSpread = (mark * this.spreadBps) / 2 / 10_000;
    const step = (mark * this.levelStepBps) / 10_000;
    for (let i = 0; i < this.levels; i++) {
      const offset = halfSpread + i * step;
      const bidPx = mark - offset;
      const askPx = mark + offset;
      out.push(
        new ManualAction({
          actionType: ActionType.PLACE_LIMIT_ORDER,
          actionArgs: { side: OrderSide.BUY, price: bidPx, size: this.quoteSize },
        }),
        new ManualAction({
          actionType: ActionType.PLACE_LIMIT_ORDER,
          actionArgs: { side: OrderSide.SELL, price: askPx, size: this.quoteSize },
        }),
      );
    }
    return out;
  }
}

/** Convenience: build a market-maker bot with sane defaults. */
export function makeMarketMaker(opts: {
  agentId: number;
  handle?: string;
  cash?: number;
  position?: number;
  spreadBps?: number;
  quoteSize?: number;
  levels?: number;
}): MarketMakerBot {
  return new MarketMakerBot({
    agentId: opts.agentId,
    profile: new TraderProfile({
      handle: opts.handle ?? `mm_${opts.agentId}`,
      initialCash: opts.cash ?? 1_000_000,
      initialPosition: opts.position ?? 0,
      persona: { style: "market-making", riskTolerance: "low", horizon: "scalp" },
    }),
    spreadBps: opts.spreadBps,
    quoteSize: opts.quoteSize,
    levels: opts.levels,
  });
}
