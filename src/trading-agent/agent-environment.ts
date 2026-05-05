import type { Channel } from "../platform/channel.ts";
import { ActionType } from "../platform/typing.ts";

export interface MarketSnapshot {
  bids: [number, number][];
  asks: [number, number][];
  mark: number | null;
}

export interface AccountSnapshot {
  cash: number;
  position: number;
  avg_entry_price: number;
  realized_pnl: number;
  unrealized_pnl: number;
  equity: number;
  fees_paid: number;
  frozen?: boolean;
}

export interface RecentTrade {
  trade_id: number;
  price: number;
  size: number;
  taker_side: string;
  created_at: string;
}

export interface OpenOrder {
  order_id: number;
  side: string;
  type: string;
  price: number | null;
  size: number;
  remaining: number;
  status: string;
}

/**
 * Per-agent view onto the exchange. Bundles the queries an LLM trader needs
 * to decide what to do. Used internally by `TradingAgent.performActionByLLM`
 * to build the user-message context, and exposed so users can build their
 * own prompts.
 */
export class MarketEnvironment {
  constructor(
    private agentId: number,
    private channel: Channel,
  ) {}

  async getOrderbook(depth: number = 5): Promise<MarketSnapshot> {
    this.channel.writeToReceiveQueue([this.agentId, { depth }, ActionType.GET_ORDERBOOK]);
    const { result } = await this.channel.readFromSendQueue(this.agentId);
    return (result.data as MarketSnapshot | undefined) ?? { bids: [], asks: [], mark: null };
  }

  async getAccount(): Promise<AccountSnapshot | null> {
    this.channel.writeToReceiveQueue([this.agentId, {}, ActionType.GET_ACCOUNT]);
    const { result } = await this.channel.readFromSendQueue(this.agentId);
    if (!result.success) return null;
    return result.data as AccountSnapshot;
  }

  async getRecentTrades(limit: number = 5): Promise<RecentTrade[]> {
    this.channel.writeToReceiveQueue([this.agentId, { limit }, ActionType.GET_RECENT_TRADES]);
    const { result } = await this.channel.readFromSendQueue(this.agentId);
    return (result.data as RecentTrade[] | undefined) ?? [];
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    this.channel.writeToReceiveQueue([this.agentId, {}, ActionType.GET_OPEN_ORDERS]);
    const { result } = await this.channel.readFromSendQueue(this.agentId);
    return (result.data as OpenOrder[] | undefined) ?? [];
  }

  /**
   * Build a rich text prompt summarizing market + account + recent activity.
   * This is what the LLM agent sees as its observation each turn.
   */
  async toTextPrompt(): Promise<string> {
    const [snap, account, trades, openOrders] = await Promise.all([
      this.getOrderbook(5),
      this.getAccount(),
      this.getRecentTrades(5),
      this.getOpenOrders(),
    ]);

    const lines: string[] = [];

    // Market state
    lines.push(`Mark price: ${snap.mark ?? "n/a"}`);
    if (snap.asks.length === 0 && snap.bids.length === 0) {
      lines.push("Order book is empty.");
    } else {
      lines.push("Asks (price × size, lowest first):");
      for (const [price, size] of snap.asks) lines.push(`  ${price} × ${size}`);
      lines.push("Bids (price × size, highest first):");
      for (const [price, size] of snap.bids) lines.push(`  ${price} × ${size}`);
    }

    // Account state
    if (account) {
      lines.push("");
      lines.push("Your account:");
      lines.push(`  cash=${account.cash.toFixed(2)} position=${account.position.toFixed(4)}`);
      lines.push(
        `  avg_entry=${account.avg_entry_price.toFixed(2)} realized_pnl=${account.realized_pnl.toFixed(2)} unrealized_pnl=${account.unrealized_pnl.toFixed(2)}`,
      );
      lines.push(`  equity=${account.equity.toFixed(2)} fees_paid=${account.fees_paid.toFixed(4)}`);
      if (account.frozen) lines.push("  STATUS: FROZEN (drawdown limit hit)");
    }

    // Open orders
    if (openOrders.length > 0) {
      lines.push("");
      lines.push("Your open orders:");
      for (const o of openOrders) {
        lines.push(
          `  #${o.order_id} ${o.side} ${o.type} ${o.price ?? "mkt"} × ${o.remaining}/${o.size}`,
        );
      }
    }

    // Recent tape
    if (trades.length > 0) {
      lines.push("");
      lines.push("Recent trades (newest first):");
      for (const t of trades) {
        lines.push(`  ${t.price} × ${t.size} (${t.taker_side} taker)`);
      }
    }

    return lines.join("\n");
  }
}
