/**
 * Shared utilities used across the framework. Keep this file dependency-free
 * (no Mastra, no DB) so it can be imported anywhere without cycles.
 */

import type { OrderSide } from "./platform/typing.ts";

/**
 * Coerce an unknown payload value to a finite number. Returns the fallback
 * when the value is missing, NaN, or non-finite. Throws on explicit garbage
 * like `"abc"` to surface bad caller code instead of letting NaN spread.
 *
 * @example
 * ```ts
 * safeNumber(p.size, 0);          // → 0 if missing
 * safeNumber(p.size);              // → throws if invalid
 * ```
 */
export function safeNumber(v: unknown, fallback?: number): number {
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    throw new Error("missing required number");
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`invalid number: ${String(v)}`);
  }
  return n;
}

/**
 * `JSON.stringify` that tolerates circular references and `BigInt`. Used by
 * `logTrace` so a buggy payload never crashes the dispatch loop.
 */
export function safeStringify(v: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(v, (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  });
}

const EPSILON = 1e-9;

/** Position state used by both the live matching engine and offline metrics. */
export interface PositionState {
  cash: number;
  position: number;
  avgEntryPrice: number;
  realizedPnl: number;
  feesPaid: number;
}

/**
 * Apply one fill to a position-state snapshot, returning a new snapshot.
 * Used by both `MatchingEngine.applyFill` (live) and `metrics.reconstructEquity`
 * (offline reconstruction) — single source of truth for accounting.
 *
 * Rules:
 * - Buying when long or flat: weighted-avg into entry.
 * - Buying when short: close shorts FIFO at the running avg, realize gain;
 *   surplus opens a new long lot at the fill price.
 * - Selling is symmetric.
 */
export function applyFillToPosition(
  state: PositionState,
  side: OrderSide,
  size: number,
  price: number,
  fee: number,
): PositionState {
  const notional = price * size;
  let { cash, position, avgEntryPrice: avg, realizedPnl: realized } = state;
  const feesPaid = state.feesPaid + fee;

  if (side === "buy") {
    cash -= notional + fee;
    const newPos = position + size;
    if (position >= 0) {
      avg = newPos > EPSILON ? (avg * position + price * size) / newPos : 0;
    } else {
      const closed = Math.min(size, -position);
      realized += (avg - price) * closed;
      const opened = size - closed;
      const remainingShort = position + closed;
      if (opened > EPSILON) avg = price;
      else if (Math.abs(remainingShort) <= EPSILON) avg = 0;
    }
    position = newPos;
  } else {
    cash += notional - fee;
    const newPos = position - size;
    if (position <= 0) {
      avg = newPos < -EPSILON ? (avg * -position + price * size) / -newPos : 0;
    } else {
      const closed = Math.min(size, position);
      realized += (price - avg) * closed;
      const opened = size - closed;
      const remainingLong = position - closed;
      if (opened > EPSILON) avg = price;
      else if (Math.abs(remainingLong) <= EPSILON) avg = 0;
    }
    position = newPos;
  }

  return { cash, position, avgEntryPrice: avg, realizedPnl: realized, feesPaid };
}
