import type { Database } from "bun:sqlite";
import { applyFillToPosition } from "../utils.ts";
import { OrderSide, OrderStatus, OrderType, type MarketSpec } from "./typing.ts";
import { nowIso, type AccountRow, type OrderRow } from "./database.ts";

export interface MatchResult {
  trades: MatchedTrade[];
  filledOrderIds: number[];
  partiallyFilledOrderIds: number[];
  restingOrderId: number | null;
  rejectReason?: string;
}

export interface MatchedTrade {
  tradeId: number;
  buyOrderId: number;
  sellOrderId: number;
  buyAgentId: number;
  sellAgentId: number;
  price: number;
  size: number;
  takerSide: OrderSide;
  buyerFee: number;
  sellerFee: number;
}

export interface SubmitOrderInput {
  agentId: number;
  side: OrderSide;
  type: OrderType;
  price?: number;
  size: number;
}

const EPSILON = 1e-9;

function quantize(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}

export class MatchingEngine {
  constructor(
    private db: Database,
    private spec: MarketSpec,
  ) {}

  submitOrder(input: SubmitOrderInput): MatchResult {
    const validation = this.validate(input);
    if (validation)
      return {
        trades: [],
        filledOrderIds: [],
        partiallyFilledOrderIds: [],
        restingOrderId: null,
        rejectReason: validation,
      };

    const account = this.getAccount(input.agentId);
    if (!account) {
      return {
        trades: [],
        filledOrderIds: [],
        partiallyFilledOrderIds: [],
        restingOrderId: null,
        rejectReason: "account_not_found",
      };
    }

    const size = quantize(input.size, this.spec.lotSize);
    const price =
      input.type === OrderType.LIMIT && input.price !== undefined
        ? quantize(input.price, this.spec.tickSize)
        : null;

    const reserveCheck = this.checkReserves(account, input.side, input.type, price, size);
    if (reserveCheck) {
      return {
        trades: [],
        filledOrderIds: [],
        partiallyFilledOrderIds: [],
        restingOrderId: null,
        rejectReason: reserveCheck,
      };
    }

    const orderId = this.insertOrder({
      agentId: input.agentId,
      side: input.side,
      type: input.type,
      price,
      size,
    });

    const trades = this.match(orderId, input.side, input.type, price, size);

    const order = this.getOrder(orderId)!;
    let resting: number | null = null;
    if (order.status === OrderStatus.OPEN || order.status === OrderStatus.PARTIAL) {
      resting = order.order_id;
    }

    return {
      trades,
      filledOrderIds: trades
        .map((t) => (input.side === OrderSide.BUY ? t.buyOrderId : t.sellOrderId))
        .filter((id) => this.getOrder(id)?.status === OrderStatus.FILLED),
      partiallyFilledOrderIds: trades
        .map((t) => (input.side === OrderSide.BUY ? t.sellOrderId : t.buyOrderId))
        .filter((id) => this.getOrder(id)?.status === OrderStatus.PARTIAL),
      restingOrderId: resting,
    };
  }

  cancelOrder(agentId: number, orderId: number): boolean {
    const order = this.getOrder(orderId);
    if (!order) return false;
    if (order.agent_id !== agentId) return false;
    if (order.status !== OrderStatus.OPEN && order.status !== OrderStatus.PARTIAL) return false;
    this.db.run(`UPDATE "order" SET status = ?, updated_at = ? WHERE order_id = ?`, [
      OrderStatus.CANCELLED,
      nowIso(),
      orderId,
    ]);
    this.releaseReserves(order);
    return true;
  }

  cancelAllForAgent(agentId: number): number {
    // Single statement instead of N+1: count first, then update all matching.
    const countRow = this.db
      .query<{ n: number }, [number, string, string]>(
        `SELECT COUNT(*) AS n FROM "order" WHERE agent_id = ? AND (status = ? OR status = ?)`,
      )
      .get(agentId, OrderStatus.OPEN, OrderStatus.PARTIAL);
    const n = countRow?.n ?? 0;
    if (n === 0) return 0;
    this.db.run(
      `UPDATE "order" SET status = ?, updated_at = ?
       WHERE agent_id = ? AND (status = ? OR status = ?)`,
      [OrderStatus.CANCELLED, nowIso(), agentId, OrderStatus.OPEN, OrderStatus.PARTIAL],
    );
    return n;
  }

  getOrderbook(depth: number = 10): { bids: [number, number][]; asks: [number, number][] } {
    type Level = { price: number; total: number };
    type Args = [string, string, string, string, number];
    const bids = this.db
      .query<Level, Args>(
        `SELECT price, SUM(remaining) AS total FROM "order"
         WHERE side = ? AND type = ? AND (status = ? OR status = ?)
         GROUP BY price ORDER BY price DESC LIMIT ?`,
      )
      .all(OrderSide.BUY, OrderType.LIMIT, OrderStatus.OPEN, OrderStatus.PARTIAL, depth);
    const asks = this.db
      .query<Level, Args>(
        `SELECT price, SUM(remaining) AS total FROM "order"
         WHERE side = ? AND type = ? AND (status = ? OR status = ?)
         GROUP BY price ORDER BY price ASC LIMIT ?`,
      )
      .all(OrderSide.SELL, OrderType.LIMIT, OrderStatus.OPEN, OrderStatus.PARTIAL, depth);
    return {
      bids: bids.map((r) => [r.price, r.total]),
      asks: asks.map((r) => [r.price, r.total]),
    };
  }

  private match(
    takerOrderId: number,
    takerSide: OrderSide,
    takerType: OrderType,
    takerPrice: number | null,
    takerSize: number,
  ): MatchedTrade[] {
    const trades: MatchedTrade[] = [];
    let remaining = takerSize;
    const oppositeSide = takerSide === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY;

    const takerOrder = this.getOrder(takerOrderId)!;
    const takerAgentId = takerOrder.agent_id;

    while (remaining > EPSILON) {
      const candidate = this.bestOpposite(oppositeSide, takerAgentId);
      if (!candidate || candidate.price === null) break;

      if (takerType === OrderType.LIMIT && takerPrice !== null) {
        const crosses =
          takerSide === OrderSide.BUY
            ? takerPrice + EPSILON >= candidate.price
            : takerPrice - EPSILON <= candidate.price;
        if (!crosses) break;
      }

      const fillSize = Math.min(remaining, candidate.remaining);
      const fillPrice = candidate.price as number;
      const buyOrderId = takerSide === OrderSide.BUY ? takerOrderId : candidate.order_id;
      const sellOrderId = takerSide === OrderSide.SELL ? takerOrderId : candidate.order_id;
      const buyAgentId = takerSide === OrderSide.BUY ? takerAgentId : candidate.agent_id;
      const sellAgentId = takerSide === OrderSide.SELL ? takerAgentId : candidate.agent_id;

      const notional = fillPrice * fillSize;
      const takerFee = (notional * this.spec.takerFeeBps) / 10_000;
      const makerFee = (notional * this.spec.makerFeeBps) / 10_000;
      const buyerFee = takerSide === OrderSide.BUY ? takerFee : makerFee;
      const sellerFee = takerSide === OrderSide.SELL ? takerFee : makerFee;

      this.applyFill(buyAgentId, fillPrice, fillSize, buyerFee, OrderSide.BUY);
      this.applyFill(sellAgentId, fillPrice, fillSize, sellerFee, OrderSide.SELL);

      this.updateOrderRemaining(takerOrderId, fillSize);
      this.updateOrderRemaining(candidate.order_id, fillSize);

      const tradeId = this.insertTrade({
        symbol: this.spec.symbol,
        buyOrderId,
        sellOrderId,
        buyAgentId,
        sellAgentId,
        price: fillPrice,
        size: fillSize,
        takerSide,
        buyerFee,
        sellerFee,
      });
      this.insertTick(fillPrice, fillSize);

      trades.push({
        tradeId,
        buyOrderId,
        sellOrderId,
        buyAgentId,
        sellAgentId,
        price: fillPrice,
        size: fillSize,
        takerSide,
        buyerFee,
        sellerFee,
      });

      remaining -= fillSize;
    }

    if (takerType === OrderType.MARKET && remaining > EPSILON) {
      this.db.run(`UPDATE "order" SET status = ?, reason = ?, updated_at = ? WHERE order_id = ?`, [
        OrderStatus.CANCELLED,
        "no_liquidity",
        nowIso(),
        takerOrderId,
      ]);
    }

    return trades;
  }

  /**
   * Find the best resting order on `side` that's not from `excludeAgentId`
   * (self-trade prevention). Falls back to first cross-agent match in
   * price-time priority.
   */
  private bestOpposite(side: OrderSide, excludeAgentId: number): OrderRow | null {
    const orderBy = side === OrderSide.BUY ? "price DESC" : "price ASC";
    const row = this.db
      .query<OrderRow, [string, string, string, string, number]>(
        `SELECT * FROM "order"
         WHERE side = ? AND type = ? AND (status = ? OR status = ?) AND agent_id != ?
         ORDER BY ${orderBy}, order_id ASC LIMIT 1`,
      )
      .get(side, OrderType.LIMIT, OrderStatus.OPEN, OrderStatus.PARTIAL, excludeAgentId);
    return row ?? null;
  }

  private validate(input: SubmitOrderInput): string | null {
    if (!Number.isFinite(input.size) || input.size <= 0) return "invalid_size";
    if (input.type === OrderType.LIMIT) {
      if (input.price === undefined || !Number.isFinite(input.price) || input.price <= 0) {
        return "invalid_price";
      }
    }
    if (input.side !== OrderSide.BUY && input.side !== OrderSide.SELL) return "invalid_side";
    return null;
  }

  private checkReserves(
    account: AccountRow,
    side: OrderSide,
    type: OrderType,
    price: number | null,
    size: number,
  ): string | null {
    if (side === OrderSide.BUY) {
      const limit =
        type === OrderType.LIMIT && price !== null
          ? price
          : this.bestOpposite(OrderSide.SELL, account.agent_id)?.price;
      if (!limit) return "no_reference_price_for_market_order";
      const reserve = limit * size * (1 + this.spec.takerFeeBps / 10_000);
      if (account.cash + EPSILON < reserve) return "insufficient_cash";
    } else if (size - account.position > EPSILON) {
      return "insufficient_position";
    }
    return null;
  }

  private insertOrder(input: {
    agentId: number;
    side: OrderSide;
    type: OrderType;
    price: number | null;
    size: number;
  }): number {
    const ts = nowIso();
    this.db.run(
      `INSERT INTO "order" (agent_id, symbol, side, type, price, size, remaining, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.agentId,
        this.spec.symbol,
        input.side,
        input.type,
        input.price,
        input.size,
        input.size,
        OrderStatus.OPEN,
        ts,
        ts,
      ],
    );
    return Number(this.db.query<{ id: number }, []>(`SELECT last_insert_rowid() as id`).get()!.id);
  }

  private updateOrderRemaining(orderId: number, fillSize: number): void {
    const order = this.getOrder(orderId)!;
    const remaining = order.remaining - fillSize;
    let status = order.status;
    if (remaining <= EPSILON) status = OrderStatus.FILLED;
    else status = OrderStatus.PARTIAL;
    this.db.run(`UPDATE "order" SET remaining = ?, status = ?, updated_at = ? WHERE order_id = ?`, [
      Math.max(0, remaining),
      status,
      nowIso(),
      orderId,
    ]);
  }

  private insertTrade(t: {
    symbol: string;
    buyOrderId: number;
    sellOrderId: number;
    buyAgentId: number;
    sellAgentId: number;
    price: number;
    size: number;
    takerSide: OrderSide;
    buyerFee: number;
    sellerFee: number;
  }): number {
    this.db.run(
      `INSERT INTO trade (symbol, buy_order_id, sell_order_id, buy_agent_id, sell_agent_id, price, size, taker_side, buyer_fee, seller_fee, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.symbol,
        t.buyOrderId,
        t.sellOrderId,
        t.buyAgentId,
        t.sellAgentId,
        t.price,
        t.size,
        t.takerSide,
        t.buyerFee,
        t.sellerFee,
        nowIso(),
      ],
    );
    return Number(this.db.query<{ id: number }, []>(`SELECT last_insert_rowid() as id`).get()!.id);
  }

  private insertTick(price: number, size: number): void {
    this.db.run(`INSERT INTO tick (symbol, price, size, created_at) VALUES (?, ?, ?, ?)`, [
      this.spec.symbol,
      price,
      size,
      nowIso(),
    ]);
  }

  private applyFill(
    agentId: number,
    price: number,
    size: number,
    fee: number,
    side: OrderSide,
  ): void {
    const acct = this.getAccount(agentId)!;
    const next = applyFillToPosition(
      {
        cash: acct.cash,
        position: acct.position,
        avgEntryPrice: acct.avg_entry_price,
        realizedPnl: acct.realized_pnl,
        feesPaid: acct.fees_paid,
      },
      side,
      size,
      price,
      fee,
    );
    this.db.run(
      `UPDATE account SET cash = ?, position = ?, avg_entry_price = ?, realized_pnl = ?, fees_paid = ? WHERE agent_id = ?`,
      [next.cash, next.position, next.avgEntryPrice, next.realizedPnl, next.feesPaid, agentId],
    );
  }

  private releaseReserves(_order: OrderRow): void {
    // Stub: cash/position aren't pre-reserved in this simple engine — we check
    // at submission and recompute on fill. Cancel is therefore a no-op for
    // balances. Kept as a hook for future margin/IOC/post-only logic.
  }

  private getAccount(agentId: number): AccountRow | null {
    return (
      this.db
        .query<AccountRow, [number]>(`SELECT * FROM account WHERE agent_id = ?`)
        .get(agentId) ?? null
    );
  }

  private getOrder(orderId: number): OrderRow | null {
    return (
      this.db.query<OrderRow, [number]>(`SELECT * FROM "order" WHERE order_id = ?`).get(orderId) ??
      null
    );
  }
}
