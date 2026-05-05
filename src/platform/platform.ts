import type { Database } from "bun:sqlite";
import { Channel } from "./channel.ts";
import { SandboxClock } from "../clock/clock.ts";
import { safeNumber } from "../utils.ts";
import {
  ActionType,
  OrderSide,
  OrderStatus,
  OrderType,
  READ_ONLY_ACTIONS,
  type ActionResult,
  type MarketSpec,
  type RiskConfig,
} from "./typing.ts";
import {
  deactivateCopyTradeEdge,
  getCopyTradeEdges,
  getSignals as getSignalsFromDb,
  insertCopyTradeEdge,
  insertSignal,
  logTrace,
  nowIso,
  openDatabase,
  type AccountRow,
  type OrderRow,
  type TradeRow,
  type TickRow,
} from "./database.ts";
import { MatchingEngine, type MatchResult, type MatchedTrade } from "./matching-engine.ts";

export interface ExchangeOptions {
  dbPath: string;
  market: MarketSpec;
  channel?: Channel;
  initialPrice?: number;
}

type Handler = (agentId: number, payload: Record<string, unknown>) => ActionResult;

export class Exchange {
  channel: Channel;
  dbPath: string;
  market: MarketSpec;
  db: Database;
  engine: MatchingEngine;
  sandboxClock: SandboxClock;

  /** Per-agent risk config. Agent IDs not present have no extra limits beyond
   * the matching engine's solvency check. */
  private riskByAgent: Map<number, RiskConfig> = new Map();
  /** Agents whose drawdown limit was hit — frozen for the rest of the run. */
  private frozen: Set<number> = new Set();
  /** Cached last mark price; invalidated by `injectPrice` and matching engine
   * fills. Saves 2-3 queries per `placeMarket`/`getAccount`. */
  private cachedMark: number | null = null;
  private running = false;
  private handlers: Map<ActionType, Handler>;

  constructor(opts: ExchangeOptions) {
    this.dbPath = opts.dbPath;
    this.channel = opts.channel ?? new Channel();
    this.market = opts.market;
    this.db = openDatabase(this.dbPath);
    this.engine = new MatchingEngine(this.db, this.market);
    this.sandboxClock = new SandboxClock();
    if (opts.initialPrice !== undefined) {
      this.injectPrice(opts.initialPrice, 0);
    }
    this.handlers = this.buildHandlers();
  }

  setRiskConfig(agentId: number, cfg: RiskConfig): void {
    this.riskByAgent.set(agentId, cfg);
  }

  isFrozen(agentId: number): boolean {
    return this.frozen.has(agentId);
  }

  /**
   * Snapshot of an agent's account, including derived fields (mark price,
   * unrealized P&L, equity, frozen flag). Public — callers like `Scenario`
   * use this instead of poking the DB directly.
   */
  snapshot(agentId: number): {
    agentId: number;
    handle: string | null;
    displayName: string | null;
    cash: number;
    position: number;
    avgEntryPrice: number;
    realizedPnl: number;
    feesPaid: number;
    markPrice: number | null;
    unrealizedPnl: number;
    equity: number;
    frozen: boolean;
  } | null {
    const row = this.db
      .query<AccountRow, [number]>(`SELECT * FROM account WHERE agent_id = ?`)
      .get(agentId);
    if (!row) return null;
    const mark = this.markPrice();
    const unrealized = mark !== null ? (mark - row.avg_entry_price) * row.position : 0;
    return {
      agentId: row.agent_id,
      handle: row.handle,
      displayName: row.display_name,
      cash: row.cash,
      position: row.position,
      avgEntryPrice: row.avg_entry_price,
      realizedPnl: row.realized_pnl,
      feesPaid: row.fees_paid,
      markPrice: mark,
      unrealizedPnl: unrealized,
      equity: row.cash + (mark !== null ? row.position * mark : 0),
      frozen: this.frozen.has(agentId),
    };
  }

  async runLoop(): Promise<void> {
    this.running = true;
    while (this.running) {
      const [agentId, payload, action] = await this.channel.readFromReceiveQueue();
      if (action === ActionType.EXIT) {
        this.running = false;
        break;
      }
      const result = this.dispatch(agentId, payload, action);
      if (agentId !== null) this.channel.writeToSendQueue(agentId, result, action);
    }
  }

  /** Last known mark — cached. Falls back to top-of-book mid if no ticks. */
  markPrice(): number | null {
    if (this.cachedMark !== null) return this.cachedMark;
    const lastTick = this.db
      .query<TickRow, [string]>(`SELECT * FROM tick WHERE symbol = ? ORDER BY tick_id DESC LIMIT 1`)
      .get(this.market.symbol);
    if (lastTick) {
      this.cachedMark = lastTick.price;
      return lastTick.price;
    }
    const ob = this.engine.getOrderbook(1);
    if (ob.bids[0] && ob.asks[0]) return (ob.bids[0][0] + ob.asks[0][0]) / 2;
    return null;
  }

  /** Inject a synthetic tick. Used by `SealionEnv.tickPricer` and initial price. */
  injectPrice(price: number, size = 0): void {
    this.db.run(`INSERT INTO tick (symbol, price, size, created_at) VALUES (?, ?, ?, ?)`, [
      this.market.symbol,
      price,
      size,
      nowIso(),
    ]);
    this.cachedMark = price;
  }

  private dispatch(
    agentId: number | null,
    payload: Record<string, unknown> | null,
    action: ActionType,
  ): ActionResult {
    if (agentId === null) return { success: false, error: "agent_id required" };
    const handler = this.handlers.get(action);
    if (!handler) {
      const err = `Unknown action: ${action}`;
      logTrace(this.db, agentId, action, payload, { error: err });
      return { success: false, error: err };
    }
    try {
      const result = handler(agentId, payload ?? {});
      // Skip trace for read-only actions to keep the trace table focused on
      // decisions; failures are still traced for debuggability.
      if (!READ_ONLY_ACTIONS.has(action) || !result.success) {
        logTrace(this.db, agentId, action, payload, result.success ? result.data : result);
      }
      return result;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error ? e.stack : undefined;
      logTrace(this.db, agentId, action, payload, { error, stack });
      return { success: false, error };
    }
  }

  private buildHandlers(): Map<ActionType, Handler> {
    return new Map<ActionType, Handler>([
      [ActionType.OPEN_ACCOUNT, (id, p) => this.openAccount(id, p)],
      [ActionType.PLACE_LIMIT_ORDER, (id, p) => this.placeLimit(id, p)],
      [ActionType.PLACE_MARKET_ORDER, (id, p) => this.placeMarket(id, p)],
      [ActionType.CANCEL_ORDER, (id, p) => this.cancel(id, p)],
      [ActionType.CANCEL_ALL_ORDERS, (id) => this.cancelAll(id)],
      [ActionType.GET_ORDERBOOK, (id, p) => this.getOrderbook(id, p)],
      [ActionType.GET_RECENT_TRADES, (id, p) => this.getRecentTrades(id, p)],
      [ActionType.GET_ACCOUNT, (id) => this.getAccount(id)],
      [ActionType.GET_OPEN_ORDERS, (id) => this.getOpenOrders(id)],
      [ActionType.DO_NOTHING, () => ({ success: true, message: "do_nothing" })],
      [ActionType.INTERVIEW, (id, p) => this.interview(id, p)],
      [ActionType.COPY_TRADE, (id, p) => this.copyTrade(id, p)],
      [ActionType.UNFOLLOW, (id) => this.unfollow(id)],
      [ActionType.GET_SIGNALS, (id, p) => this.getSignals(id, p)],
      [ActionType.SHARE_SIGNAL, (id, p) => this.shareSignal(id, p)],
    ]);
  }

  // ─── Trading ──────────────────────────────────────────────────────────────

  private openAccount(agentId: number, p: Record<string, unknown>): ActionResult {
    const existing = this.db
      .query<AccountRow, [number]>(`SELECT * FROM account WHERE agent_id = ?`)
      .get(agentId);
    if (existing) return { success: true, data: existing, message: "already opened" };
    const cash = safeNumber(p.cash, 10_000);
    const position = safeNumber(p.position, 0);
    const displayName = p.display_name == null ? null : String(p.display_name);
    const handle = p.handle == null ? null : String(p.handle);
    // RETURNING * saves a follow-up SELECT.
    const row = this.db
      .query<AccountRow, [number, string | null, string | null, number, number, string]>(
        `INSERT INTO account (agent_id, display_name, handle, cash, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(agentId, displayName, handle, cash, position, nowIso())!;
    return { success: true, data: row };
  }

  private validateSide(s: unknown): OrderSide | null {
    if (s === OrderSide.BUY || s === OrderSide.SELL) return s;
    return null;
  }

  private placeLimit(agentId: number, p: Record<string, unknown>): ActionResult {
    if (this.frozen.has(agentId)) return { success: false, error: "agent_frozen" };
    const side = this.validateSide(p.side);
    if (!side) return { success: false, error: "invalid_side" };
    let price: number;
    let size: number;
    try {
      price = safeNumber(p.price);
      size = safeNumber(p.size);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    const riskGate = this.riskGate(agentId, side, size, price);
    if (riskGate) return { success: false, error: riskGate };
    const result = this.engine.submitOrder({
      agentId,
      side,
      type: OrderType.LIMIT,
      price,
      size,
    });
    return this.afterSubmit(agentId, result, result.restingOrderId);
  }

  private placeMarket(agentId: number, p: Record<string, unknown>): ActionResult {
    if (this.frozen.has(agentId)) return { success: false, error: "agent_frozen" };
    const side = this.validateSide(p.side);
    if (!side) return { success: false, error: "invalid_side" };
    let size: number;
    try {
      size = safeNumber(p.size);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    const ref = this.markPrice();
    const riskGate = this.riskGate(agentId, side, size, ref);
    if (riskGate) return { success: false, error: riskGate };
    const result = this.engine.submitOrder({
      agentId,
      side,
      type: OrderType.MARKET,
      size,
    });
    return this.afterSubmit(agentId, result, null);
  }

  private afterSubmit(
    agentId: number,
    result: MatchResult,
    restingOrderId: number | null,
  ): ActionResult {
    if (result.rejectReason) return { success: false, error: result.rejectReason };
    // Fills produced new ticks → invalidate mark cache.
    if (result.trades.length > 0) {
      this.cachedMark = result.trades[result.trades.length - 1]!.price;
    }
    for (const trade of result.trades) this.replicateForCopiers(agentId, trade);
    this.enforceDrawdown(agentId);
    return { success: true, data: this.summarizeMatch(result.trades, restingOrderId) };
  }

  private cancel(agentId: number, p: Record<string, unknown>): ActionResult {
    let orderId: number;
    try {
      orderId = safeNumber(p.order_id);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    const ok = this.engine.cancelOrder(agentId, orderId);
    return ok
      ? { success: true, data: { order_id: orderId, status: OrderStatus.CANCELLED } }
      : { success: false, error: "cancel_failed" };
  }

  private cancelAll(agentId: number): ActionResult {
    const n = this.engine.cancelAllForAgent(agentId);
    return { success: true, data: { cancelled: n } };
  }

  private getOrderbook(_agentId: number, p: Record<string, unknown>): ActionResult {
    const depth = Math.max(1, Math.min(50, Number(p.depth ?? 10)));
    return { success: true, data: { ...this.engine.getOrderbook(depth), mark: this.markPrice() } };
  }

  private getRecentTrades(_agentId: number, p: Record<string, unknown>): ActionResult {
    const limit = Math.max(1, Math.min(200, Number(p.limit ?? 20)));
    const rows = this.db
      .query<TradeRow, [string, number]>(
        `SELECT * FROM trade WHERE symbol = ? ORDER BY trade_id DESC LIMIT ?`,
      )
      .all(this.market.symbol, limit);
    return { success: true, data: rows };
  }

  private getAccount(agentId: number): ActionResult {
    const row = this.db
      .query<AccountRow, [number]>(`SELECT * FROM account WHERE agent_id = ?`)
      .get(agentId);
    if (!row) return { success: false, error: "account_not_found" };
    const mark = this.markPrice();
    const unrealized = mark !== null ? (mark - row.avg_entry_price) * row.position : 0;
    return {
      success: true,
      data: {
        ...row,
        mark_price: mark,
        unrealized_pnl: unrealized,
        equity: row.cash + (mark !== null ? row.position * mark : 0),
        frozen: this.frozen.has(agentId),
      },
    };
  }

  private getOpenOrders(agentId: number): ActionResult {
    const rows = this.db
      .query<OrderRow, [number, string, string]>(
        `SELECT * FROM "order" WHERE agent_id = ? AND (status = ? OR status = ?) ORDER BY order_id`,
      )
      .all(agentId, OrderStatus.OPEN, OrderStatus.PARTIAL);
    return { success: true, data: rows };
  }

  private interview(agentId: number, p: Record<string, unknown>): ActionResult {
    const prompt = String(p.prompt ?? "");
    const response = String(p.response ?? "");
    this.db.run(
      `INSERT INTO interview (agent_id, prompt, response, created_at) VALUES (?, ?, ?, ?)`,
      [agentId, prompt, response, nowIso()],
    );
    return { success: true, data: { prompt, response } };
  }

  // ─── Social / copy-trade ──────────────────────────────────────────────────

  private copyTrade(agentId: number, p: Record<string, unknown>): ActionResult {
    let leaderId: number;
    let ratio: number;
    try {
      leaderId = safeNumber(p.leader_id);
      ratio = safeNumber(p.ratio, 1);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (leaderId < 0) return { success: false, error: "invalid_leader_id" };
    if (leaderId === agentId) return { success: false, error: "cannot_copy_self" };
    if (ratio <= 0 || ratio > 1) return { success: false, error: "invalid_ratio" };
    const leader = this.db
      .query<AccountRow, [number]>(`SELECT * FROM account WHERE agent_id = ?`)
      .get(leaderId);
    if (!leader) return { success: false, error: "leader_not_found" };
    deactivateCopyTradeEdge(this.db, agentId);
    insertCopyTradeEdge(this.db, leaderId, agentId, ratio);
    return { success: true, data: { leader_id: leaderId, follower_id: agentId, ratio } };
  }

  private unfollow(agentId: number): ActionResult {
    deactivateCopyTradeEdge(this.db, agentId);
    return { success: true, data: { follower_id: agentId, status: "unfollowed" } };
  }

  private getSignals(_agentId: number, p: Record<string, unknown>): ActionResult {
    const limit = Math.max(1, Math.min(200, Number(p.limit ?? 50)));
    return { success: true, data: getSignalsFromDb(this.db, undefined, limit) };
  }

  private shareSignal(agentId: number, p: Record<string, unknown>): ActionResult {
    const content = String(p.content ?? "").trim();
    if (!content) return { success: false, error: "empty_signal_content" };
    const symbol = p.symbol == null ? undefined : String(p.symbol);
    const bias = p.bias == null ? undefined : String(p.bias);
    if (bias && !["bull", "bear", "neutral"].includes(bias)) {
      return { success: false, error: "invalid_bias" };
    }
    insertSignal(this.db, agentId, content, symbol, bias);
    return { success: true, data: { agent_id: agentId, content, symbol, bias } };
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private replicateForCopiers(leaderId: number, trade: MatchedTrade): void {
    const leaderWasTaker =
      (trade.takerSide === OrderSide.BUY && trade.buyAgentId === leaderId) ||
      (trade.takerSide === OrderSide.SELL && trade.sellAgentId === leaderId);
    if (!leaderWasTaker) return;

    const edges = getCopyTradeEdges(this.db, leaderId);
    if (edges.length === 0) return;

    for (const edge of edges) {
      const followerId = edge.follower_id;
      if (this.frozen.has(followerId)) continue;
      const size = trade.size * edge.ratio;
      if (size <= 0) continue;
      this.engine.submitOrder({
        agentId: followerId,
        side: trade.takerSide,
        type: OrderType.MARKET,
        size,
      });
    }
  }

  private riskGate(
    agentId: number,
    side: OrderSide,
    size: number,
    refPrice: number | null,
  ): string | null {
    const cfg = this.riskByAgent.get(agentId);
    if (!cfg) return null;
    if (cfg.maxOrderNotional && refPrice !== null) {
      const notional = refPrice * size;
      if (notional > cfg.maxOrderNotional) return "order_exceeds_max_notional";
    }
    // Skip the account query unless there's a position-cap to enforce.
    if (cfg.maxPosition && cfg.maxPosition > 0) {
      const acct = this.db
        .query<AccountRow, [number]>(`SELECT position FROM account WHERE agent_id = ?`)
        .get(agentId);
      if (acct) {
        const projected = side === OrderSide.BUY ? acct.position + size : acct.position - size;
        if (Math.abs(projected) > cfg.maxPosition) return "position_limit_exceeded";
      }
    }
    return null;
  }

  private enforceDrawdown(agentId: number): void {
    const cfg = this.riskByAgent.get(agentId);
    if (!cfg?.maxDrawdown) return;
    const acct = this.db
      .query<AccountRow, [number]>(`SELECT * FROM account WHERE agent_id = ?`)
      .get(agentId);
    if (!acct) return;
    const mark = this.markPrice();
    const unrealized = mark !== null ? (mark - acct.avg_entry_price) * acct.position : 0;
    const totalPnl = acct.realized_pnl + unrealized;
    if (-totalPnl >= cfg.maxDrawdown) {
      this.frozen.add(agentId);
      this.engine.cancelAllForAgent(agentId);
    }
  }

  private summarizeMatch(
    trades: MatchedTrade[],
    restingOrderId: number | null,
  ): Record<string, unknown> {
    const filledQty = trades.reduce((s, t) => s + t.size, 0);
    const avgFill =
      filledQty > 0 ? trades.reduce((s, t) => s + t.size * t.price, 0) / filledQty : null;
    return {
      filled_size: filledQty,
      avg_fill_price: avgFill,
      num_fills: trades.length,
      resting_order_id: restingOrderId,
    };
  }
}
