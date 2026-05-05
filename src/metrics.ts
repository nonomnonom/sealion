import type { Database } from "bun:sqlite";
import type { AccountRow, TickRow, TradeRow } from "./platform/database.ts";

export interface EquityPoint {
  timestamp: string;
  equity: number;
  realizedPnl: number;
  position: number;
  mark: number;
}

export interface Metrics {
  /** Final equity (cash + position×mark) minus starting equity. */
  totalReturn: number;
  totalReturnPct: number;
  /** Annualized Sharpe ratio assuming 365 trading periods/year if periods provided. */
  sharpe: number;
  /** Maximum peak-to-trough drawdown in equity (absolute and as % of peak). */
  maxDrawdown: number;
  maxDrawdownPct: number;
  /** Number of fills the agent participated in. */
  numTrades: number;
  /** Wins / total closed-trade roundtrips (very rough — uses each fill against avg entry). */
  winRate: number;
  /** Sum of fees paid. */
  feesPaid: number;
  /** Final equity. */
  finalEquity: number;
  /** Realized + unrealized P&L. */
  totalPnl: number;
}

export interface ComputeOptions {
  /**
   * Periods per year used to annualize Sharpe. Defaults to the number of
   * equity points per simulation day (assuming all points from one day).
   * Override to e.g. 252 for daily-bar backtests of equities.
   */
  periodsPerYear?: number;
  /** Risk-free rate per period (decimal). Default 0. */
  riskFreeRate?: number;
  /** Starting position. Important for position-only simulations. */
  startingPosition?: number;
  /** Starting average entry price (only matters when startingPosition != 0). */
  startingAvgEntry?: number;
}

/**
 * Reconstruct an equity curve for a given agent by walking ticks chronologically
 * and re-pricing the agent's position at each tick using the snapshot of trades
 * up to that point.
 *
 * `startingPosition` and `startingAvgEntry` matter for agents seeded with a
 * non-zero position (e.g. position-only sims).
 */
export function reconstructEquity(
  db: Database,
  agentId: number,
  startingCash: number,
  startingPosition: number = 0,
  startingAvgEntry: number = 0,
): EquityPoint[] {
  const ticks = db.query<TickRow, []>(`SELECT * FROM tick ORDER BY tick_id ASC`).all();
  const trades = db
    .query<TradeRow, [number, number]>(
      `SELECT * FROM trade WHERE buy_agent_id = ? OR sell_agent_id = ? ORDER BY trade_id ASC`,
    )
    .all(agentId, agentId);

  let cash = startingCash;
  let position = startingPosition;
  let avgEntry = startingAvgEntry;
  let realized = 0;
  let tradeIdx = 0;

  const out: EquityPoint[] = [];
  for (const tick of ticks) {
    while (tradeIdx < trades.length && trades[tradeIdx]!.created_at <= tick.created_at) {
      const t = trades[tradeIdx]!;
      const isBuy = t.buy_agent_id === agentId;
      const size = t.size;
      const price = t.price;
      const fee = isBuy ? t.buyer_fee : t.seller_fee;

      if (isBuy) {
        cash -= price * size + fee;
        const newPos = position + size;
        if (position >= 0) {
          avgEntry = newPos > 0 ? (avgEntry * position + price * size) / newPos : 0;
        } else {
          const closed = Math.min(size, -position);
          realized += (avgEntry - price) * closed;
          if (size - closed > 0) avgEntry = price;
          else if (position + closed === 0) avgEntry = 0;
        }
        position = newPos;
      } else {
        cash += price * size - fee;
        const newPos = position - size;
        if (position <= 0) {
          avgEntry = newPos < 0 ? (avgEntry * -position + price * size) / -newPos : 0;
        } else {
          const closed = Math.min(size, position);
          realized += (price - avgEntry) * closed;
          if (size - closed > 0) avgEntry = price;
          else if (position - closed === 0) avgEntry = 0;
        }
        position = newPos;
      }
      tradeIdx += 1;
    }
    out.push({
      timestamp: tick.created_at,
      equity: cash + position * tick.price,
      realizedPnl: realized,
      position,
      mark: tick.price,
    });
  }
  return out;
}

export function computeMetrics(
  db: Database,
  agentId: number,
  startingCash: number,
  opts: ComputeOptions = {},
): Metrics {
  const acct = db
    .query<AccountRow, [number]>(`SELECT * FROM account WHERE agent_id = ?`)
    .get(agentId);
  if (!acct) {
    return {
      totalReturn: 0,
      totalReturnPct: 0,
      sharpe: 0,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
      numTrades: 0,
      winRate: 0,
      feesPaid: 0,
      finalEquity: startingCash,
      totalPnl: 0,
    };
  }
  const equity = reconstructEquity(
    db,
    agentId,
    startingCash,
    opts.startingPosition ?? 0,
    opts.startingAvgEntry ?? 0,
  );
  const finalEquity = equity.length
    ? equity[equity.length - 1]!.equity
    : acct.cash + acct.position * (acct.avg_entry_price || 0);

  // Total return is measured against starting equity (cash + position notional
  // at the first tick price), so position-only sims report meaningful returns.
  const startingEquity = startingCash + (opts.startingPosition ?? 0) * (equity[0]?.mark ?? 0);
  const totalReturn = finalEquity - startingEquity;
  const totalReturnPct = startingEquity > 0 ? (totalReturn / startingEquity) * 100 : 0;

  // Period returns from equity curve.
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]!.equity;
    const curr = equity[i]!.equity;
    if (prev !== 0) returns.push((curr - prev) / Math.abs(prev));
  }

  const periodsPerYear = opts.periodsPerYear ?? Math.max(1, equity.length);
  const rf = opts.riskFreeRate ?? 0;
  const sharpe = computeSharpe(returns, rf, periodsPerYear);

  // Max drawdown from equity curve.
  let peak = equity[0]?.equity ?? startingCash;
  let maxDD = 0;
  let maxDDPct = 0;
  for (const point of equity) {
    if (point.equity > peak) peak = point.equity;
    const dd = peak - point.equity;
    if (dd > maxDD) maxDD = dd;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (ddPct > maxDDPct) maxDDPct = ddPct;
  }

  // Trade stats — properly paired FIFO roundtrips.
  const trades = db
    .query<TradeRow, [number, number]>(
      `SELECT * FROM trade WHERE buy_agent_id = ? OR sell_agent_id = ? ORDER BY trade_id ASC`,
    )
    .all(agentId, agentId);
  const stats = tradeRoundtripStats(trades, agentId);
  const winRate = stats.total > 0 ? stats.wins / stats.total : 0;

  const totalPnl = finalEquity - startingCash;

  return {
    totalReturn,
    totalReturnPct,
    sharpe,
    maxDrawdown: maxDD,
    maxDrawdownPct: maxDDPct,
    numTrades: trades.length,
    winRate,
    feesPaid: acct.fees_paid,
    finalEquity,
    totalPnl,
  };
}

function computeSharpe(returns: number[], rf: number, periodsPerYear: number): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  const excess = mean - rf;
  return (excess / std) * Math.sqrt(periodsPerYear);
}

/**
 * Count winning round-trips by FIFO-pairing fills.
 *
 * Each opening fill pushes onto a queue (longs or shorts). Each closing fill
 * pops from the opposite queue and records a roundtrip P&L = exit - entry
 * (signed). A win is a roundtrip with positive P&L.
 *
 * Returns `{ wins, total }` where `total` is the number of completed
 * roundtrips. Win rate = wins / total. Returns 0/0 if no roundtrips closed.
 */
function tradeRoundtripStats(trades: TradeRow[], agentId: number): { wins: number; total: number } {
  // Each entry in the queue: { size, price } for an open lot.
  const longs: Array<{ size: number; price: number }> = [];
  const shorts: Array<{ size: number; price: number }> = [];
  let wins = 0;
  let total = 0;

  for (const t of trades) {
    const isBuy = t.buy_agent_id === agentId;
    let remaining = t.size;
    const price = t.price;

    if (isBuy) {
      // Buy closes shorts first (FIFO), then opens longs with the leftover.
      while (remaining > 0 && shorts.length > 0) {
        const lot = shorts[0]!;
        const closed = Math.min(remaining, lot.size);
        const pnl = (lot.price - price) * closed; // short profits when price falls
        total += 1;
        if (pnl > 0) wins += 1;
        lot.size -= closed;
        remaining -= closed;
        if (lot.size <= 0) shorts.shift();
      }
      if (remaining > 0) longs.push({ size: remaining, price });
    } else {
      // Sell closes longs first (FIFO), then opens shorts with the leftover.
      while (remaining > 0 && longs.length > 0) {
        const lot = longs[0]!;
        const closed = Math.min(remaining, lot.size);
        const pnl = (price - lot.price) * closed; // long profits when price rises
        total += 1;
        if (pnl > 0) wins += 1;
        lot.size -= closed;
        remaining -= closed;
        if (lot.size <= 0) longs.shift();
      }
      if (remaining > 0) shorts.push({ size: remaining, price });
    }
  }
  return { wins, total };
}
