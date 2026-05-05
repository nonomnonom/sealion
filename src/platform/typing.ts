export enum ActionType {
  EXIT = "exit",
  OPEN_ACCOUNT = "open_account",
  // Trading
  PLACE_LIMIT_ORDER = "place_limit_order",
  PLACE_MARKET_ORDER = "place_market_order",
  CANCEL_ORDER = "cancel_order",
  CANCEL_ALL_ORDERS = "cancel_all_orders",
  GET_ORDERBOOK = "get_orderbook",
  GET_RECENT_TRADES = "get_recent_trades",
  GET_ACCOUNT = "get_account",
  GET_OPEN_ORDERS = "get_open_orders",
  DO_NOTHING = "do_nothing",
  INTERVIEW = "interview",
  // Social / copy-trade
  COPY_TRADE = "copy_trade",
  UNFOLLOW = "unfollow",
  GET_SIGNALS = "get_signals",
  SHARE_SIGNAL = "share_signal",
}

/**
 * Read-only actions don't mutate exchange state. The exchange skips trace
 * logging for these to keep the `trace` table focused on decision points.
 */
export const READ_ONLY_ACTIONS: ReadonlySet<ActionType> = new Set([
  ActionType.GET_ORDERBOOK,
  ActionType.GET_RECENT_TRADES,
  ActionType.GET_ACCOUNT,
  ActionType.GET_OPEN_ORDERS,
  ActionType.GET_SIGNALS,
  ActionType.DO_NOTHING,
]);

export const DEFAULT_TRADER_ACTIONS: ActionType[] = [
  ActionType.PLACE_LIMIT_ORDER,
  ActionType.PLACE_MARKET_ORDER,
  ActionType.CANCEL_ORDER,
  ActionType.GET_ORDERBOOK,
  ActionType.GET_RECENT_TRADES,
  ActionType.GET_ACCOUNT,
  ActionType.GET_OPEN_ORDERS,
  ActionType.DO_NOTHING,
];

export const SOCIAL_TRADER_ACTIONS: ActionType[] = [
  ActionType.COPY_TRADE,
  ActionType.UNFOLLOW,
  ActionType.GET_SIGNALS,
  ActionType.SHARE_SIGNAL,
];

export const SOCIAL_PLUS_TRADING_ACTIONS: ActionType[] = [
  ...DEFAULT_TRADER_ACTIONS,
  ...SOCIAL_TRADER_ACTIONS,
];

export enum OrderSide {
  BUY = "buy",
  SELL = "sell",
}

export enum OrderType {
  LIMIT = "limit",
  MARKET = "market",
}

export enum OrderStatus {
  OPEN = "open",
  PARTIAL = "partial",
  FILLED = "filled",
  CANCELLED = "cancelled",
  REJECTED = "rejected",
}

export enum DefaultMarketType {
  SPOT = "spot",
}

export interface MarketSpec {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: number;
  lotSize: number;
  takerFeeBps: number;
  makerFeeBps: number;
}

/** Per-trader risk limits enforced by the exchange before each fill. */
export interface RiskConfig {
  /** Max absolute position size (long or short). 0 = no limit. */
  maxPosition?: number;
  /** Max loss in quote currency before the agent is frozen for the run. */
  maxDrawdown?: number;
  /** Max notional per single order. 0 = no limit. */
  maxOrderNotional?: number;
}

export interface ActionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export type ChannelMessage = [
  agentId: number | null,
  payload: Record<string, unknown> | null,
  action: ActionType,
];

export type ChannelResponse = {
  actionType: ActionType;
  result: ActionResult;
};
